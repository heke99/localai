export interface WorkerLaneLoopOptions {
  concurrency: number;
  aggregateIdlePollMs: number;
  errorBackoffMs: number;
  shouldStop: () => boolean;
  processOnce: (lane: number) => Promise<boolean>;
  onError?: (error: unknown, lane: number) => void;
  sleep?: (ms: number) => Promise<void>;
}

export function boundedWorkerConcurrency(requested: number, modelParallel: number): number {
  const modelSlots = Math.max(1, Math.floor(Number.isFinite(modelParallel) ? modelParallel : 1));
  const requestedSlots = Math.max(1, Math.floor(Number.isFinite(requested) ? requested : modelSlots));
  return Math.min(requestedSlots, modelSlots);
}

function defaultSleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export async function runWorkerLanes(options: WorkerLaneLoopOptions): Promise<void> {
  const concurrency = Math.max(1, Math.floor(options.concurrency));
  const aggregateIdlePollMs = Math.max(25, Math.floor(options.aggregateIdlePollMs));
  const laneIdlePollMs = aggregateIdlePollMs * concurrency;
  const errorBackoffMs = Math.max(100, Math.floor(options.errorBackoffMs));
  const sleep = options.sleep ?? defaultSleep;

  const runLane = async (lane: number) => {
    // Spread empty-queue claims across the aggregate poll interval so raising
    // worker concurrency does not multiply idle Supabase RPC traffic.
    if (lane > 0) await sleep(Math.max(1, Math.floor((aggregateIdlePollMs * lane) / concurrency)));

    while (!options.shouldStop()) {
      try {
        const processed = await options.processOnce(lane);
        if (!processed && !options.shouldStop()) await sleep(laneIdlePollMs);
      } catch (error) {
        options.onError?.(error, lane);
        if (!options.shouldStop()) await sleep(errorBackoffMs);
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, (_, lane) => runLane(lane)));
}
