import { describe, expect, it } from "vitest";
// The production gate is a plain ESM CLI module consumed by the GPUHub runtime.
// @ts-expect-error no declaration file is needed for this runtime-only module.
import { evaluateP8SoakGate } from "../../../scripts/p8_soak_gate.mjs";

function passingBundle() {
  const evalResult = {
    allowed: true,
    modelParallel: 8,
    cases: 7,
    passed: 7,
    failed: 0,
    passRate: 1,
    liveOracleFailures: [] as string[]
  };
  return {
    evaluations: {
      pre: { ...evalResult },
      loaded: { ...evalResult },
      post: { ...evalResult }
    },
    soak: {
      summary: {
        requests: 48,
        successes: 48,
        errors: 0,
        errorRate: 0,
        ttftMs: { p95: 6200 },
        totalMs: { p95: 12800 }
      },
      healthFailures: 0,
      oomIndicators: 0
    },
    gpu: { maxVramUsageRatio: 0.91 },
    restored: {
      healthy: true,
      workerHealthy: true,
      searchHealthy: true,
      parallel: 1,
      contextSize: 32768
    },
    thresholds: {
      minRequests: 24,
      maxErrors: 0,
      maxTtftP95Ms: 10000,
      maxTotalP95Ms: 20000,
      maxVramUsageRatio: 0.94
    }
  };
}

describe("p8 soak gate", () => {
  it("allows p8 only when quality, load stability, GPU pressure and rollback are all healthy", () => {
    const result = evaluateP8SoakGate(passingBundle());
    expect(result.allowed).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("fails closed when any full agent eval regresses or a live oracle fails", () => {
    const bundle = passingBundle();
    bundle.evaluations.loaded.allowed = false;
    bundle.evaluations.loaded.liveOracleFailures = ["current-node-release"];
    const result = evaluateP8SoakGate(bundle);
    expect(result.allowed).toBe(false);
    expect(result.failures).toContain("eval_loaded_not_allowed");
    expect(result.failures).toContain("eval_loaded_live_oracle_failures:current-node-release");
  });

  it("rejects evidence that was not actually produced under parallel 8", () => {
    const bundle = passingBundle();
    bundle.evaluations.post.modelParallel = 4;
    const result = evaluateP8SoakGate(bundle);
    expect(result.allowed).toBe(false);
    expect(result.failures).toContain("eval_post_wrong_parallel:4");
  });

  it("rejects request errors, latency regression, health failures, OOM evidence or excessive VRAM", () => {
    const bundle = passingBundle();
    bundle.soak.summary.errors = 1;
    bundle.soak.summary.errorRate = 1 / bundle.soak.summary.requests;
    bundle.soak.summary.ttftMs.p95 = 12000;
    bundle.soak.summary.totalMs.p95 = 25000;
    bundle.soak.healthFailures = 1;
    bundle.soak.oomIndicators = 1;
    bundle.gpu.maxVramUsageRatio = 0.97;
    const result = evaluateP8SoakGate(bundle);
    expect(result.allowed).toBe(false);
    expect(result.failures).toEqual(expect.arrayContaining([
      "soak_errors:1",
      "soak_ttft_p95_exceeded:12000",
      "soak_total_p95_exceeded:25000",
      "soak_health_failures:1",
      "soak_oom_indicators:1",
      "gpu_vram_ratio_exceeded:0.97"
    ]));
  });

  it("rejects an incomplete soak or failure to restore the exact p1 baseline", () => {
    const bundle = passingBundle();
    bundle.soak.summary.requests = 10;
    bundle.restored.parallel = 8;
    bundle.restored.contextSize = 262144;
    bundle.restored.workerHealthy = false;
    const result = evaluateP8SoakGate(bundle);
    expect(result.allowed).toBe(false);
    expect(result.failures).toEqual(expect.arrayContaining([
      "soak_insufficient_requests:10",
      "restore_wrong_parallel:8",
      "restore_wrong_context:262144",
      "restore_worker_unhealthy"
    ]));
  });
});
