import type { ModelToolCall, ModelToolDefinition } from "@div3rsa/model-sdk";
import type { ClaimedRun, WorkerToolRuntime } from "./processor";

const DEFAULT_LIST_TIMEOUT_MS = 15_000;
const DEFAULT_EXECUTE_TIMEOUT_MS = 90_000;
const RECOVERABLE_RESEARCH_TOOLS = new Set(["web_search", "web_fetch"]);

export interface CompositeWorkerToolRuntimeOptions {
  listTimeoutMs?: number;
  executeTimeoutMs?: number;
}

function positiveTimeout(value: number | undefined, fallback: number): number {
  if (value == null) return fallback;
  if (!Number.isFinite(value) || value <= 0) throw new Error("invalid_tool_runtime_timeout");
  return Math.floor(value);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorCode: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(errorCode)), timeoutMs);
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function recoverableResearchFailure(call: ModelToolCall, error: unknown): Record<string, unknown> | null {
  if (!RECOVERABLE_RESEARCH_TOOLS.has(call.name)) return null;
  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    tool: call.name,
    error: message.slice(0, 500),
    retryable: /timeout|abort|429|502|503|connection|unavailable|network|fetch failed/i.test(message),
    observation: "research_tool_unavailable"
  };
}

export class CompositeWorkerToolRuntime implements WorkerToolRuntime {
  private readonly listTimeoutMs: number;
  private readonly executeTimeoutMs: number;

  constructor(
    private readonly runtimes: readonly WorkerToolRuntime[],
    options: CompositeWorkerToolRuntimeOptions = {}
  ) {
    if (!runtimes.length) throw new Error("tool_runtime_required");
    this.listTimeoutMs = positiveTimeout(options.listTimeoutMs, DEFAULT_LIST_TIMEOUT_MS);
    this.executeTimeoutMs = positiveTimeout(options.executeTimeoutMs, DEFAULT_EXECUTE_TIMEOUT_MS);
  }

  async list(run: ClaimedRun): Promise<ModelToolDefinition[]> {
    const definitions = (await Promise.all(this.runtimes.map((runtime, index) => withTimeout(
      runtime.list(run),
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

  async execute(run: ClaimedRun, call: ModelToolCall): Promise<unknown> {
    for (let index = 0; index < this.runtimes.length; index += 1) {
      const runtime = this.runtimes[index];
      const definitions = await withTimeout(
        runtime.list(run),
        this.listTimeoutMs,
        `tool_runtime_timeout:list:${index}`
      );
      if (definitions.some((definition) => definition.name === call.name)) {
        try {
          return await withTimeout(
            runtime.execute(run, call),
            this.executeTimeoutMs,
            `tool_runtime_timeout:execute:${call.name}`
          );
        } catch (error) {
          const observation = recoverableResearchFailure(call, error);
          if (observation) return observation;
          throw error;
        }
      }
    }
    throw new Error(`unknown_worker_tool:${call.name}`);
  }
}
