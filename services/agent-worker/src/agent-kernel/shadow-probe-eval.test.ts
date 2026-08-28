import { describe, expect, it } from "vitest";
import { DEFAULT_SHADOW_PROBE_PROMOTION_THRESHOLDS, evaluateShadowProbePromotion, type ShadowProbeEvalCase, type ShadowProbeLoadSample } from "./shadow-probe-eval";

function cases(): ShadowProbeEvalCase[] {
  return Array.from({ length: 20 }, (_, index) => {
    const weak = index < 8;
    return {
      id: `case-${index + 1}`,
      expectedWeakBaseline: weak,
      verifierScore: weak ? 55 : 90,
      verifierPassed: !weak,
      reasonCode: weak ? "missing_evidence" : "baseline_supported"
    };
  });
}

function load(overrides: Partial<ShadowProbeLoadSample> = {}): ShadowProbeLoadSample {
  return {
    sampledRuns: 100,
    completedRuns: 98,
    capacitySkippedRuns: 2,
    probeErrors: 0,
    totalProbeCalls: 250,
    totalProbeOutputTokens: 24_000,
    wallDurationMs: 60_000,
    p95ProbeDurationMs: 2_500,
    baselineP95TtftMs: 1_000,
    loadedP95TtftMs: 1_030,
    baselineAggregateTokensPerSecond: 200,
    loadedAggregateTokensPerSecond: 194,
    ...overrides
  };
}

describe("evaluateShadowProbePromotion", () => {
  it("allows promotion only when quality and load gates are both green", () => {
    const report = evaluateShadowProbePromotion(cases(), load());
    expect(report.allowed).toBe(true);
    expect(report.blockers).toEqual([]);
    expect(report.quality.weakDetectionRate).toBe(1);
    expect(report.quality.falsePositiveRate).toBe(0);
  });

  it("fails closed when evaluation coverage is insufficient", () => {
    const report = evaluateShadowProbePromotion(cases().slice(0, 10), load());
    expect(report.allowed).toBe(false);
    expect(report.blockers).toContain("insufficient_eval_cases");
  });

  it("blocks weak detection regressions and false positives", () => {
    const degraded = cases().map((item, index) => index < 4
      ? { ...item, verifierScore: 90, verifierPassed: true, reasonCode: "missed_weakness" }
      : index === 9
        ? { ...item, verifierScore: 40, verifierPassed: false, reasonCode: "false_alarm" }
        : item);
    const report = evaluateShadowProbePromotion(degraded, load());
    expect(report.allowed).toBe(false);
    expect(report.blockers).toContain("weak_detection_rate_below_threshold");
    expect(report.blockers).toContain("false_positive_rate_above_threshold");
  });

  it("blocks unparsed verifier outputs", () => {
    const degraded = cases();
    degraded[0] = { ...degraded[0]!, verifierScore: null, verifierPassed: null, reasonCode: "verifier_output_unparsed" };
    const report = evaluateShadowProbePromotion(degraded, load());
    expect(report.allowed).toBe(false);
    expect(report.blockers).toContain("unparsed_or_incomplete_verifier_output");
  });

  it("blocks TTFT and throughput regressions", () => {
    const report = evaluateShadowProbePromotion(cases(), load({ loadedP95TtftMs: 1_100, loadedAggregateTokensPerSecond: 180 }));
    expect(report.allowed).toBe(false);
    expect(report.blockers).toContain("ttft_regression_above_threshold");
    expect(report.blockers).toContain("throughput_regression_above_threshold");
  });

  it("blocks excessive probe errors, capacity skips and token use", () => {
    const report = evaluateShadowProbePromotion(cases(), load({
      completedRuns: 80,
      capacitySkippedRuns: 10,
      probeErrors: 10,
      totalProbeOutputTokens: 100_000
    }));
    expect(report.allowed).toBe(false);
    expect(report.blockers).toContain("probe_error_rate_above_threshold");
    expect(report.blockers).toContain("capacity_skip_rate_above_threshold");
    expect(report.blockers).toContain("probe_token_budget_above_threshold");
  });

  it("fails closed on invalid or missing load evidence", () => {
    const report = evaluateShadowProbePromotion(cases(), load({ sampledRuns: 0, completedRuns: 0, capacitySkippedRuns: 0, probeErrors: 0, baselineP95TtftMs: 0 }));
    expect(report.allowed).toBe(false);
    expect(report.blockers).toContain("no_load_samples");
    expect(report.blockers).toContain("ttft_regression_above_threshold");
  });

  it("keeps conservative default thresholds explicit", () => {
    expect(DEFAULT_SHADOW_PROBE_PROMOTION_THRESHOLDS).toMatchObject({
      minEvalCases: 20,
      minWeakBaselineCases: 8,
      minWeakDetectionRate: 0.8,
      maxFalsePositiveRate: 0.1,
      maxProbeErrorRate: 0.02,
      maxCapacitySkipRate: 0.05,
      maxP95TtftRegressionRatio: 0.05,
      maxAggregateThroughputRegressionRatio: 0.05,
      maxP95ProbeDurationMs: 4_000,
      maxOutputTokensPerSampledRun: 768
    });
  });
});
