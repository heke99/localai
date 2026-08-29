import { describe, expect, it } from "vitest";
import { evaluateOptimizationCandidate } from "./optimizer";
import type { VerifiedLearningDatasetManifest } from "./learning-export";

const dataset: VerifiedLearningDatasetManifest = {
  schemaVersion: 1,
  queryVersion: "verified-learning-v1",
  generatedAt: "2026-08-29T22:00:00.000Z",
  createdBefore: "2026-08-29T21:00:00.000Z",
  minReward: 1,
  minimumSamples: 25,
  recordCount: 25,
  readyForOptimization: true,
  datasetDigest: "a".repeat(64),
  records: []
};

const baseline = {
  candidateId: "baseline",
  evalVersion: "runtime-eval-v1",
  evalSetDigest: "e".repeat(64),
  cases: 8,
  passed: 8,
  passRate: 1,
  allowed: true,
  liveOracleFailures: [] as string[],
  p95TtftMs: 1000,
  p95TotalMs: 3000,
  meanReward: 8
};

const candidate = {
  ...baseline,
  candidateId: "candidate-a",
  p95TtftMs: 980,
  p95TotalMs: 2900,
  meanReward: 9
};

const definition = { candidateId: "candidate-a", promptVersion: "kernel-v2-prompt-b", routingProfile: "researcher-first-v1" };

describe("offline optimization promotion gate", () => {
  it("allows only a verified non-regressing candidate", () => {
    const decision = evaluateOptimizationCandidate({ dataset, baseline, candidate, definition });
    expect(decision.allowed).toBe(true);
    expect(decision.reasons).toEqual([]);
    expect(decision.evalSetDigest).toBe(baseline.evalSetDigest);
    expect(decision.decisionDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("fails closed on live oracle failure", () => {
    const decision = evaluateOptimizationCandidate({ dataset, baseline, candidate: { ...candidate, liveOracleFailures: ["node-current-release"] }, definition });
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toContain("live_oracle_failure");
  });

  it("fails closed if candidate and baseline did not use the exact same frozen eval set", () => {
    const decision = evaluateOptimizationCandidate({ dataset, baseline, candidate: { ...candidate, evalSetDigest: "f".repeat(64) }, definition });
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toContain("eval_set_digest_mismatch");
  });

  it("fails closed on quality regression even when latency improves", () => {
    const regressed = { ...candidate, passed: 7, passRate: 7 / 8, p95TtftMs: 500 };
    const decision = evaluateOptimizationCandidate({ dataset, baseline, candidate: regressed, definition });
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toContain("quality_regression");
    expect(decision.reasons).toContain("passed_case_regression");
  });

  it("fails closed when the verified learning sample is too small", () => {
    const decision = evaluateOptimizationCandidate({ dataset: { ...dataset, readyForOptimization: false, recordCount: 12 }, baseline, candidate, definition });
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toContain("insufficient_verified_learning_samples");
  });

  it("blocks unacceptable performance regressions", () => {
    const decision = evaluateOptimizationCandidate({ dataset, baseline, candidate: { ...candidate, p95TtftMs: 1100, p95TotalMs: 3300 }, definition });
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toContain("ttft_regression");
    expect(decision.reasons).toContain("total_latency_regression");
  });

  it("ties the decision to an exact dataset digest", () => {
    const first = evaluateOptimizationCandidate({ dataset, baseline, candidate, definition });
    const second = evaluateOptimizationCandidate({ dataset: { ...dataset, datasetDigest: "b".repeat(64) }, baseline, candidate, definition });
    expect(first.decisionDigest).not.toBe(second.decisionDigest);
  });
});
