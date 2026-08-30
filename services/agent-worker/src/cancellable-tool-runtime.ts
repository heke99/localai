import { createHash } from "node:crypto";
import type { ModelToolCall, ModelToolDefinition } from "@div3rsa/model-sdk";
import type { AgentQueue, ClaimedRun, WorkerToolRuntime } from "./processor";

export interface ToolExecutionContext {
  signal: AbortSignal;
  executionId: string;
  operationId: string;
  attempt: number;
}

type ContextAwareToolRuntime = WorkerToolRuntime & {
  execute(run: ClaimedRun, call: ModelToolCall, context?: ToolExecutionContext): Promise<unknown>;
  beginRun?(run: ClaimedRun): Promise<void> | void;
  endRun?(run: ClaimedRun, outcome?: string): Promise<void> | void;
};

const DEFAULT_POLL_MS = 150;

function stableOperationId(run: ClaimedRun, call: ModelToolCall): string {
  return createHash("sha256")
    .update(`${run.runId}\u0000${call.id}\u0000${call.name}`)
    .digest("hex");
}

export class CancellableWorkerToolRuntime implements WorkerToolRuntime {
  constructor(
    private readonly delegate: WorkerToolRuntime,
    private readonly queue: AgentQueue,
    private readonly pollMs = DEFAULT_POLL_MS
  ) {
    if (!Number.isFinite(pollMs) || pollMs < 25) throw new Error("invalid_tool_cancellation_poll_ms");
  }

  list(run: ClaimedRun): Promise<ModelToolDefinition[]> {
    return this.delegate.list(run);
  }

  async execute(run: ClaimedRun, call: ModelToolCall): Promise<unknown> {
    const runtime = this.delegate as ContextAwareToolRuntime;
    const controller = new AbortController();
    let finished = false;
    let polling = false;

    const pollCancellation = async () => {
      if (finished || polling || controller.signal.aborted) return;
      polling = true;
      try {
        if (await this.queue.isCancelled(run.runId)) {
          controller.abort(new DOMException("Run cancelled", "AbortError"));
        }
      } finally {
        polling = false;
      }
    };

    await pollCancellation();
    if (controller.signal.aborted) throw controller.signal.reason;
    const timer = setInterval(() => { void pollCancellation(); }, this.pollMs);
    timer.unref?.();
    try {
      return await runtime.execute(run, call, {
        signal: controller.signal,
        executionId: call.id,
        operationId: stableOperationId(run, call),
        attempt: 1
      });
    } finally {
      finished = true;
      clearInterval(timer);
    }
  }

  beginRun(run: ClaimedRun): Promise<void> | void {
    return (this.delegate as ContextAwareToolRuntime).beginRun?.(run);
  }

  endRun(run: ClaimedRun, outcome?: string): Promise<void> | void {
    return (this.delegate as ContextAwareToolRuntime).endRun?.(run, outcome);
  }
}
