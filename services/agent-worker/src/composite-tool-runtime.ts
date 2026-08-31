import type { ModelToolCall, ModelToolDefinition } from "@div3rsa/model-sdk";
import type { ClaimedRun, WorkerToolRuntime } from "./processor";
import { canonicalInputHash, normalizeToolResult, operationId } from "./tool-execution-lifecycle";
import type { ToolExecutionContext } from "./tool-execution-context";
import { toolPolicy, toolTimeoutMs } from "./tool-registry";

const DEFAULT_LIST_TIMEOUT_MS = 15_000;
const DEFAULT_EXECUTE_TIMEOUT_MS = 90_000;
const DEFAULT_CANCELLATION_POLL_MS = 100;
const MAX_PROGRESS_RUNS = 1024;
const RECOVERABLE_RESEARCH_TOOLS = new Set(["web_search", "web_fetch"]);
const VOLATILE_OBSERVATION_KEYS = new Set(["durationMs", "auditId", "observationId", "retrievedAt", "checkedAt", "generatedAt", "timestamp"]);

type ToolExecutionClaim = {
  executionId: string;
  status: string;
  executeAllowed: boolean;
  replayed: boolean;
  result?: unknown;
  attempt: number;
  errorCode?: string;
};

type ToolExecutionTransitionInput = {
  executionId: string;
  status: "completed" | "failed" | "cancelling" | "cancelled" | "blocked";
  attempt?: number;
  outputSummary?: unknown;
  errorCode?: string | null;
  retryable?: boolean;
};

interface RunProgressState {
  lastSignature: string | null;
  lastToolName: string | null;
  lastObservationFingerprint: string | null;
}

export interface CompositeWorkerToolRuntimeOptions {
  listTimeoutMs?: number;
  executeTimeoutMs?: number;
  cancellationPollMs?: number;
  isCancellationRequested?: (runId: string) => Promise<boolean>;
  claimToolExecution?: (run: ClaimedRun, call: ModelToolCall, operationId: string) => Promise<ToolExecutionClaim>;
  transitionToolExecution?: (input: ToolExecutionTransitionInput) => Promise<void>;
  finalizeCancellation?: (runId: string) => Promise<void>;
}

type LifecycleWorkerToolRuntime = WorkerToolRuntime & {
  execute(run: ClaimedRun, call: ModelToolCall, context?: ToolExecutionContext): Promise<unknown>;
  beginRun?(run: ClaimedRun): Promise<void> | void;
  endRun?(run: ClaimedRun, outcome?: string): Promise<void> | void;
};

function positiveTimeout(value: number | undefined, fallback: number): number {
  if (value == null) return fallback;
  if (!Number.isFinite(value) || value <= 0) throw new Error("invalid_tool_runtime_timeout");
  return Math.floor(value);
}

function abortReason(reason: unknown): Error {
  return reason instanceof Error ? reason : new DOMException("Aborted", "AbortError");
}

function supabaseConfiguration(): { baseUrl: string; serviceKey: string } | null {
  const baseUrl = process.env.SUPABASE_URL?.trim().replace(/\/+$/, "");
  const serviceKey = process.env.SUPABASE_SECRET_KEY?.trim();
  return baseUrl && serviceKey ? { baseUrl, serviceKey } : null;
}

async function supabaseRpc(name: string, args: Record<string, unknown>): Promise<unknown> {
  const config = supabaseConfiguration();
  if (!config) throw new Error("tool_lifecycle_configuration_required");
  const response = await fetch(`${config.baseUrl}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      apikey: config.serviceKey,
      authorization: `Bearer ${config.serviceKey}`
    },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(5_000)
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = body && typeof body === "object" && !Array.isArray(body) && typeof (body as Record<string, unknown>).message === "string"
      ? String((body as Record<string, unknown>).message)
      : `rpc_${response.status}`;
    throw new Error(`tool_lifecycle_rpc_failed:${name}:${detail}`);
  }
  return body;
}

async function defaultCancellationCheck(runId: string): Promise<boolean> {
  if (!supabaseConfiguration()) return false;
  return (await supabaseRpc("worker_is_agent_run_cancelled", { target_run_id: runId })) === true;
}

async function defaultClaimToolExecution(run: ClaimedRun, call: ModelToolCall, stableOperationId: string): Promise<ToolExecutionClaim> {
  if (!supabaseConfiguration()) {
    return { executionId: call.id, status: "running", executeAllowed: true, replayed: false, attempt: 1 };
  }
  const policy = toolPolicy(call.name);
  const value = await supabaseRpc("worker_claim_agent_tool_execution", {
    target_run_id: run.runId,
    target_tool_call_id: call.id,
    target_operation_id: stableOperationId,
    target_tool_name: call.name,
    target_input_hash: canonicalInputHash(call.input),
    target_input_redacted: { keys: Object.keys(call.input).sort() },
    target_mutating: policy?.mutating === true,
    target_reversible: policy?.reversible === true,
    target_scope_snapshot: policy?.scopePolicy ? { policy: policy.scopePolicy } : null
  });
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("tool_execution_claim_invalid");
  const row = value as Record<string, unknown>;
  const executionId = typeof row.executionId === "string" ? row.executionId : "";
  if (!executionId) throw new Error("tool_execution_claim_invalid");
  return {
    executionId,
    status: typeof row.status === "string" ? row.status : "unknown",
    executeAllowed: row.executeAllowed === true,
    replayed: row.replayed === true,
    result: row.result,
    attempt: typeof row.attempt === "number" && Number.isInteger(row.attempt) && row.attempt > 0 ? row.attempt : 1,
    errorCode: typeof row.errorCode === "string" ? row.errorCode : undefined
  };
}

async function defaultTransitionToolExecution(input: ToolExecutionTransitionInput): Promise<void> {
  if (!supabaseConfiguration() || !/^[0-9a-f-]{36}$/i.test(input.executionId)) return;
  await supabaseRpc("worker_transition_agent_tool_execution", {
    target_execution_id: input.executionId,
    target_status: input.status,
    target_attempt: input.attempt ?? null,
    target_output_summary: input.outputSummary ?? null,
    target_error_code: input.errorCode ?? null,
    target_retryable: input.retryable ?? null,
    target_provider_resource_id: null,
    target_external_operation_id: null,
    target_rollback_status: null
  });
}

async function defaultFinalizeCancellation(runId: string): Promise<void> {
  if (!supabaseConfiguration()) return;
  await supabaseRpc("worker_finalize_agent_run_cancellation", { target_run_id: runId });
}

async function withAbortableTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  errorCode: string,
  parent?: AbortSignal
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let parentAbort: (() => void) | undefined;

  const operationPromise = Promise.resolve().then(() => operation(controller.signal));
  const timeoutPromise = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(errorCode);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
    timer.unref?.();
  });

  const racers: Promise<T>[] = [operationPromise, timeoutPromise];
  if (parent) {
    racers.push(new Promise<T>((_resolve, reject) => {
      parentAbort = () => {
        const error = abortReason(parent.reason);
        controller.abort(error);
        reject(error);
      };
      if (parent.aborted) parentAbort();
      else parent.addEventListener("abort", parentAbort, { once: true });
    }));
  }

  try {
    return await Promise.race(racers);
  } finally {
    if (timer) clearTimeout(timer);
    if (parent && parentAbort) parent.removeEventListener("abort", parentAbort);
  }
}

function recoverableResearchFailure(call: ModelToolCall, error: unknown): Record<string, unknown> | null {
  if (!RECOVERABLE_RESEARCH_TOOLS.has(call.name)) return null;
  const message = error instanceof Error ? error.message : String(error);
  const retryable = /timeout|abort|429|502|503|connection|unavailable|network|fetch failed/i.test(message);
  return {
    ok: false,
    status: "failed",
    tool: call.name,
    error: message.slice(0, 500),
    retryable,
    observation: "research_tool_unavailable",
    adaptationRequired: true
  };
}

function retryableFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /timeout|429|502|503|504|connection|unavailable|network|fetch failed/i.test(message);
}

function materialObservation(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(materialObservation);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key, entry]) => entry !== undefined && !VOLATILE_OBSERVATION_KEYS.has(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, materialObservation(entry)]));
  }
  return value;
}

function duplicateObservation(call: ModelToolCall): Record<string, unknown> {
  return {
    ok: false,
    status: "blocked",
    tool: call.name,
    error: { code: "duplicate_tool_call_suppressed", retryable: false },
    observation: "duplicate_action_no_progress",
    duplicateSuppressed: true,
    noProgress: true,
    adaptationRequired: true,
    suggestedAction: "Use a materially different available tool or stop if the required capability is unavailable."
  };
}

function withProgressSignal(output: unknown, noProgress: boolean): unknown {
  if (!noProgress || !output || typeof output !== "object" || Array.isArray(output)) return output;
  return {
    ...(output as Record<string, unknown>),
    noProgress: true,
    adaptationRequired: true,
    suggestedAction: "The previous materially different call produced the same observation. Change strategy or stop instead of looping."
  };
}

export class CompositeWorkerToolRuntime implements WorkerToolRuntime {
  private readonly listTimeoutMs: number;
  private readonly executeTimeoutMs: number;
  private readonly cancellationPollMs: number;
  private readonly isCancellationRequested: (runId: string) => Promise<boolean>;
  private readonly claimToolExecution: (run: ClaimedRun, call: ModelToolCall, operationId: string) => Promise<ToolExecutionClaim>;
  private readonly transitionToolExecution: (input: ToolExecutionTransitionInput) => Promise<void>;
  private readonly finalizeCancellation: (runId: string) => Promise<void>;
  private readonly progressByRun = new Map<string, RunProgressState>();

  constructor(
    private readonly runtimes: readonly WorkerToolRuntime[],
    options: CompositeWorkerToolRuntimeOptions = {}
  ) {
    if (!runtimes.length) throw new Error("tool_runtime_required");
    this.listTimeoutMs = positiveTimeout(options.listTimeoutMs, DEFAULT_LIST_TIMEOUT_MS);
    this.executeTimeoutMs = positiveTimeout(options.executeTimeoutMs, DEFAULT_EXECUTE_TIMEOUT_MS);
    this.cancellationPollMs = positiveTimeout(options.cancellationPollMs, DEFAULT_CANCELLATION_POLL_MS);
    this.isCancellationRequested = options.isCancellationRequested ?? defaultCancellationCheck;
    this.claimToolExecution = options.claimToolExecution ?? defaultClaimToolExecution;
    this.transitionToolExecution = options.transitionToolExecution ?? defaultTransitionToolExecution;
    this.finalizeCancellation = options.finalizeCancellation ?? defaultFinalizeCancellation;
  }

  private progressState(runId: string): RunProgressState {
    const existing = this.progressByRun.get(runId);
    if (existing) return existing;
    if (this.progressByRun.size >= MAX_PROGRESS_RUNS) {
      const oldest = this.progressByRun.keys().next().value as string | undefined;
      if (oldest) this.progressByRun.delete(oldest);
    }
    const created: RunProgressState = { lastSignature: null, lastToolName: null, lastObservationFingerprint: null };
    this.progressByRun.set(runId, created);
    return created;
  }

  async list(run: ClaimedRun): Promise<ModelToolDefinition[]> {
    const definitions = (await Promise.all(this.runtimes.map((runtime, index) => withAbortableTimeout(
      () => runtime.list(run),
      this.listTimeoutMs,
      `tool_runtime_timeout:list:${index}`
    )))).flat();
    const names = new Set<string>();
    for (const definition of definitions) {
      if (names.has(definition.name)) throw new Error(`duplicate_tool_name:${definition.name}`);
      names.add(definition.name);
    }
    return definitions;
  }

  private cancellationSignal(runId: string, parent?: AbortSignal): { signal: AbortSignal; dispose: () => void } {
    const controller = new AbortController();
    const onParentAbort = () => controller.abort(abortReason(parent?.reason));
    if (parent?.aborted) onParentAbort();
    else parent?.addEventListener("abort", onParentAbort, { once: true });

    let checking = false;
    const check = async () => {
      if (checking || controller.signal.aborted) return;
      checking = true;
      try {
        if (await this.isCancellationRequested(runId)) controller.abort(new Error("run_cancelled"));
      } catch {
        // A transient cancellation-poll failure must not manufacture cancellation.
      } finally {
        checking = false;
      }
    };
    void check();
    const timer = setInterval(() => { void check(); }, this.cancellationPollMs);
    timer.unref?.();

    return {
      signal: controller.signal,
      dispose: () => {
        clearInterval(timer);
        parent?.removeEventListener("abort", onParentAbort);
      }
    };
  }

  async execute(run: ClaimedRun, call: ModelToolCall, context?: ToolExecutionContext): Promise<unknown> {
    const cancellation = this.cancellationSignal(run.runId, context?.signal);
    const stableOperationId = context?.operationId ?? operationId(run.runId, call.id);
    const progress = this.progressState(run.runId);
    const signature = `${call.name}:${canonicalInputHash(call.input)}`;
    const duplicate = progress.lastSignature === signature
      && progress.lastToolName === call.name
      && progress.lastObservationFingerprint !== null;
    let claim: ToolExecutionClaim | null = null;
    try {
      for (let index = 0; index < this.runtimes.length; index += 1) {
        const runtime = this.runtimes[index] as LifecycleWorkerToolRuntime;
        const definitions = await withAbortableTimeout(
          () => runtime.list(run),
          this.listTimeoutMs,
          `tool_runtime_timeout:list:${index}`,
          cancellation.signal
        );
        if (!definitions.some((definition) => definition.name === call.name)) continue;

        claim = await this.claimToolExecution(run, call, stableOperationId);
        if (claim.replayed) return claim.result;
        if (!claim.executeAllowed) {
          if (["running", "waiting", "cancelling"].includes(claim.status)) throw new Error(`tool_operation_in_progress:${call.name}`);
          throw new Error(`tool_operation_terminal:${call.name}:${claim.status}:${claim.errorCode ?? "unknown"}`);
        }

        if (duplicate) {
          const observation = duplicateObservation(call);
          await this.transitionToolExecution({
            executionId: claim.executionId,
            status: "blocked",
            attempt: claim.attempt,
            outputSummary: observation,
            errorCode: "duplicate_tool_call_suppressed",
            retryable: false
          });
          return observation;
        }
        progress.lastSignature = signature;

        try {
          const timeoutMs = Math.min(toolTimeoutMs(call.name, this.executeTimeoutMs), this.executeTimeoutMs);
          const rawOutput = await withAbortableTimeout(
            (signal) => runtime.execute(run, call, {
              signal,
              executionId: claim!.executionId,
              operationId: stableOperationId,
              attempt: claim!.attempt
            }),
            timeoutMs,
            `tool_runtime_timeout:execute:${call.name}`,
            cancellation.signal
          );
          const fingerprint = canonicalInputHash(materialObservation(rawOutput));
          const noProgress = progress.lastToolName === call.name && progress.lastObservationFingerprint === fingerprint;
          const output = withProgressSignal(rawOutput, noProgress);
          progress.lastToolName = call.name;
          progress.lastObservationFingerprint = fingerprint;
          const normalized = normalizeToolResult(output);
          await this.transitionToolExecution({
            executionId: claim.executionId,
            status: normalized.status,
            attempt: claim.attempt,
            outputSummary: normalized.data ?? output,
            errorCode: normalized.error?.code ?? null,
            retryable: normalized.error?.retryable ?? false
          });
          if (normalized.status === "cancelled") await this.finalizeCancellation(run.runId);
          return output;
        } catch (error) {
          const cancelled = cancellation.signal.aborted || (error instanceof Error && (error.name === "AbortError" || /run_cancelled/i.test(error.message)));
          if (cancelled) {
            await this.transitionToolExecution({ executionId: claim.executionId, status: "cancelling", attempt: claim.attempt, errorCode: "run_cancelled", retryable: false }).catch(() => undefined);
            await this.transitionToolExecution({ executionId: claim.executionId, status: "cancelled", attempt: claim.attempt, errorCode: "run_cancelled", retryable: false }).catch(() => undefined);
            await this.finalizeCancellation(run.runId).catch(() => undefined);
            throw error;
          }

          const retryable = retryableFailure(error);
          await this.transitionToolExecution({
            executionId: claim.executionId,
            status: "failed",
            attempt: claim.attempt,
            errorCode: error instanceof Error ? error.message.slice(0,160) : "tool_failed",
            retryable
          }).catch(() => undefined);
          const observation = recoverableResearchFailure(call, error);
          if (observation) {
            const fingerprint = canonicalInputHash(materialObservation(observation));
            const noProgress = progress.lastToolName === call.name && progress.lastObservationFingerprint === fingerprint;
            progress.lastToolName = call.name;
            progress.lastObservationFingerprint = fingerprint;
            return withProgressSignal(observation, noProgress);
          }
          progress.lastSignature = null;
          throw error;
        }
      }
      throw new Error(`unknown_worker_tool:${call.name}`);
    } finally {
      cancellation.dispose();
    }
  }

  async beginRun(run: ClaimedRun): Promise<void> {
    this.progressByRun.delete(run.runId);
    for (const runtime of this.runtimes as readonly LifecycleWorkerToolRuntime[]) await runtime.beginRun?.(run);
  }

  async endRun(run: ClaimedRun, outcome?: string): Promise<void> {
    try {
      for (const runtime of [...this.runtimes].reverse() as LifecycleWorkerToolRuntime[]) await runtime.endRun?.(run, outcome);
    } finally {
      this.progressByRun.delete(run.runId);
    }
  }
}
