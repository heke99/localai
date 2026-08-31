export interface ToolExecutionContext {
  signal?: AbortSignal;
  executionId?: string;
  operationId?: string;
  attempt?: number;
}

function abortReason(reason: unknown, fallback: string): Error {
  return reason instanceof Error ? reason : new DOMException(fallback, "AbortError");
}

export function linkedAbortController(parent: AbortSignal | undefined, timeoutMs: number, timeoutCode: string): {
  controller: AbortController;
  dispose: () => void;
  timedOut: () => boolean;
} {
  const controller = new AbortController();
  let timeoutTriggered = false;
  const onParentAbort = () => controller.abort(abortReason(parent?.reason, "tool_execution_cancelled"));
  if (parent?.aborted) onParentAbort();
  else parent?.addEventListener("abort", onParentAbort, { once: true });

  const timer = setTimeout(() => {
    timeoutTriggered = true;
    controller.abort(new Error(timeoutCode));
  }, timeoutMs);
  timer.unref?.();

  return {
    controller,
    timedOut: () => timeoutTriggered,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParentAbort);
    }
  };
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw abortReason(signal.reason, "tool_execution_cancelled");
}
