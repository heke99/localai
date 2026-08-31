import type { ModelToolCall, ModelToolDefinition } from "@div3rsa/model-sdk";
import type { ClaimedRun, WorkerToolRuntime } from "./processor";
import { operationId } from "./tool-execution-lifecycle";
import type { ToolExecutionContext } from "./tool-execution-context";
import { toolTimeoutMs } from "./tool-registry";

const DEFAULT_LIST_TIMEOUT_MS = 15_000;
const DEFAULT_EXECUTE_TIMEOUT_MS = 90_000;
const DEFAULT_CANCELLATION_POLL_MS = 100;
const RECOVERABLE_RESEARCH_TOOLS = new Set(["web_search", "web_fetch"]);

export interface CompositeWorkerToolRuntimeOptions {
  listTimeoutMs?: number;
  executeTimeoutMs?: number;
  cancellationPollMs?: number;
  isCancellationRequested?: (runId: string) => Promise<boolean>;
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

async function defaultCancellationCheck(runId: string): Promise<boolean> {
  const baseUrl = process.env.SUPABASE_URL?.trim().replace(/\/+$/, "");
  const serviceKey = process.env.SUPABASE_SECRET_KEY?.trim();
  if (!baseUrl || !serviceKey) return false;
  const response = await fetch(`${baseUrl}/rest/v1/rpc/worker_is_agent_run_cancelled`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      apikey: serviceKey,
      authorization: `Bearer ${serviceKey}`
    },
    body: JSON.stringify({ target_run_id: runId }),
    signal: AbortSignal.timeout(2_000)
  });
  if (!response.ok) return false;
  return (await response.json().catch(() => false)) === true;
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
    observation: "research_tool_unavailable"
  };
}

export class CompositeWorkerToolRuntime implements WorkerToolRuntime {
  private readonly listTimeoutMs: number;
  private readonly executeTimeoutMs: number;
  private readonly cancellationPollMs: number;
  private readonly isCancellationRequested: (runId: string) => Promise<boolean>;

  constructor(
    private readonly runtimes: readonly WorkerToolRuntime[],
    options: CompositeWorkerToolRuntimeOptions = {}
  ) {
    if (!runtimes.length) throw new Error("tool_runtime_required");
    this.listTimeoutMs = positiveTimeout(options.listTimeoutMs, DEFAULT_LIST_TIMEOUT_MS);
    this.executeTimeoutMs = positiveTimeout(options.executeTimeoutMs, DEFAULT_EXECUTE_TIMEOUT_MS);
    this.cancellationPollMs = positiveTimeout(options.cancellationPollMs, DEFAULT_CANCELLATION_POLL_MS);
    this.isCancellationRequested = options.isCancellationRequested ?? defaultCancellationCheck;
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
        // The queue remains the source of truth. A transient cancellation-poll failure
        // must not manufacture cancellation or rerun the provider operation.
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
    try {
      for (let index = 0; index < this.runtimes.length; index += 1) {
        const runtime = this.runtimes[index] as LifecycleWorkerToolRuntime;
        const definitions = await withAbortableTimeout(
          () => runtime.list(run),
          this.listTimeoutMs,
          `tool_runtime_timeout:list:${index}`,
          cancellation.signal
        );
        if (definitions.some((definition) => definition.name === call.name)) {
          try {
            const timeoutMs = Math.min(toolTimeoutMs(call.name, this.executeTimeoutMs), this.executeTimeoutMs);
            return await withAbortableTimeout(
              (signal) => runtime.execute(run, call, {
                signal,
                executionId: context?.executionId ?? call.id,
                operationId: stableOperationId,
                attempt: context?.attempt ?? 1
              }),
              timeoutMs,
              `tool_runtime_timeout:execute:${call.name}`,
              cancellation.signal
            );
          } catch (error) {
            if (cancellation.signal.aborted) throw error;
            const observation = recoverableResearchFailure(call, error);
            if (observation) return observation;
            throw error;
          }
        }
      }
      throw new Error(`unknown_worker_tool:${call.name}`);
    } finally {
      cancellation.dispose();
    }
  }

  async beginRun(run: ClaimedRun): Promise<void> {
    for (const runtime of this.runtimes as readonly LifecycleWorkerToolRuntime[]) await runtime.beginRun?.(run);
  }

  async endRun(run: ClaimedRun, outcome?: string): Promise<void> {
    for (const runtime of [...this.runtimes].reverse() as LifecycleWorkerToolRuntime[]) await runtime.endRun?.(run, outcome);
  }
}
