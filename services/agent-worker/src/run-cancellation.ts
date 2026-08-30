type CancellationCheck = () => Promise<boolean>;

type CancellationEntry = {
  controller: AbortController;
  timer: ReturnType<typeof setInterval>;
  checking: boolean;
};

const entries = new Map<string, CancellationEntry>();
const DEFAULT_POLL_MS = 150;

export function registerRunCancellation(runId: string, check: CancellationCheck, pollMs = DEFAULT_POLL_MS): AbortSignal {
  unregisterRunCancellation(runId);
  if (!Number.isFinite(pollMs) || pollMs < 25) throw new Error("invalid_run_cancellation_poll_ms");

  const controller = new AbortController();
  const entry = { controller, timer: undefined as unknown as ReturnType<typeof setInterval>, checking: false };
  const poll = async () => {
    if (entry.checking || controller.signal.aborted) return;
    entry.checking = true;
    try {
      if (await check()) controller.abort(new DOMException("Run cancelled", "AbortError"));
    } catch {
      // Queue connectivity must not spuriously cancel a running operation.
    } finally {
      entry.checking = false;
    }
  };

  entry.timer = setInterval(() => { void poll(); }, Math.floor(pollMs));
  entry.timer.unref?.();
  entries.set(runId, entry);
  void poll();
  return controller.signal;
}

export function runCancellationSignal(runId: string): AbortSignal | undefined {
  return entries.get(runId)?.controller.signal;
}

export function unregisterRunCancellation(runId: string): void {
  const entry = entries.get(runId);
  if (!entry) return;
  clearInterval(entry.timer);
  entries.delete(runId);
}

export function activeRunCancellationWatchers(): number {
  return entries.size;
}
