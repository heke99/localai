import { describe, expect, it } from "vitest";
import { buildTrainingPlan, evaluateCanary, planGpuReconciliation, redactTelemetry, traceEvent } from "./index";

describe("operations runtime", () => {
  it("blocks a canary on quality or operational regression and identifies rollback", () => {
    expect(evaluateCanary({ previousDeploymentId: "stable", candidateDeploymentId: "candidate", metrics: [{ key: "tool_validity", baseline: 0.95, candidate: 0.8, maximumRegression: 0.02, critical: true }] })).toEqual({ promote: false, rollbackTo: "stable", blockers: ["critical_regression:tool_validity"] });
  });

  it("creates reproducible QLoRA execution arguments without shell interpolation", () => {
    const plan = buildTrainingPlan({ method: "qlora", baseModelRevision: "a".repeat(40), baseArtifactSha256: "b".repeat(64), datasetHash: "c".repeat(64), datasetStatus: "frozen", seed: 42, epochs: 2, learningRate: 0.0002, computePool: "training", outputUri: "s3://artifacts/run-1" });
    expect(plan.command[0]).toBe("accelerate");
    expect(plan.command).toContain("--load_in_4bit");
    expect(plan.manifestHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("redacts telemetry and makes deterministic scaling plans", () => {
    expect(redactTelemetry({ token: "secret", prompt: "private", status: "failed" })).toEqual({ token: "[REDACTED]", prompt: "[REDACTED]", status: "failed" });
    expect(traceEvent({ traceId: "t", runId: "r", service: "gateway", name: "model.failed", at: "2026-08-22T00:00:00Z", attributes: { error: "timeout" } }).traceId).toBe("t");
    expect(planGpuReconciliation({ minimumWarm: 1, maximumWorkers: 3, ready: 1, provisioning: 0, queueDepth: 5, averageUtilization: 90 })).toEqual({ action: "provision", count: 1 });
  });
});
