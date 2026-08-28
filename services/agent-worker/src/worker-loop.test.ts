import { describe, expect, it } from "vitest";
import { boundedWorkerConcurrency, runWorkerLanes } from "./worker-loop";

describe("worker lane scheduler", () => {
  it("bounds worker concurrency to the available model slots", () => {
    expect(boundedWorkerConcurrency(8, 8)).toBe(8);
    expect(boundedWorkerConcurrency(12, 8)).toBe(8);
    expect(boundedWorkerConcurrency(0, 8)).toBe(1);
    expect(boundedWorkerConcurrency(Number.NaN, 4)).toBe(4);
  });

  it("keeps another lane processing when one lane is blocked", async () => {
    let stopping = false;
    let releaseBlockedLane!: () => void;
    const blockedLane = new Promise<void>((resolve) => { releaseBlockedLane = resolve; });
    let laneOneProcessed!: () => void;
    const laneOneDone = new Promise<void>((resolve) => { laneOneProcessed = resolve; });
    const calls = [0, 0];

    const running = runWorkerLanes({
      concurrency: 2,
      aggregateIdlePollMs: 25,
      errorBackoffMs: 100,
      shouldStop: () => stopping,
      sleep: async () => {},
      processOnce: async (lane) => {
        calls[lane] += 1;
        if (lane === 0 && calls[lane] === 1) {
          await blockedLane;
          return true;
        }
        if (lane === 1) {
          stopping = true;
          laneOneProcessed();
          return true;
        }
        return false;
      }
    });

    await laneOneDone;
    expect(calls[0]).toBe(1);
    expect(calls[1]).toBeGreaterThanOrEqual(1);

    releaseBlockedLane();
    await running;
  });

  it("isolates lane errors instead of terminating the whole worker", async () => {
    let stopping = false;
    const errors: number[] = [];
    let healthyLaneProcessed!: () => void;
    const healthyLaneDone = new Promise<void>((resolve) => { healthyLaneProcessed = resolve; });

    const running = runWorkerLanes({
      concurrency: 2,
      aggregateIdlePollMs: 25,
      errorBackoffMs: 100,
      shouldStop: () => stopping,
      sleep: async () => {},
      onError: (_error, lane) => errors.push(lane),
      processOnce: async (lane) => {
        if (lane === 0) throw new Error("lane_zero_failure");
        stopping = true;
        healthyLaneProcessed();
        return true;
      }
    });

    await healthyLaneDone;
    await running;
    expect(errors).toContain(0);
  });
});
