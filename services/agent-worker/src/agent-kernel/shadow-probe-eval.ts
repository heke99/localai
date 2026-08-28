export interface ShadowProbeEvalCase {
  readonly id: string;
  readonly expectedWeakBaseline: boolean;
  readonly verifierScore: number | null;
  readonly verifierPassed: boolean | null;
  readonly reasonCode: string;
}

export interface ShadowProbeLoadSample {
  readonly sampledRuns: number;
  readonly completedRuns: number;
  readonly capacitySkippedRuns: number;
  readonly probeErrors: number;
  readonly totalProbeCalls: number;
  readonly totalProbeOutputTokens: number;
  readonly wallDurationMs: number;
  readonly p95ProbeDurationMs: number;
  readonly baselineP95TtftMs: number;
  readonly loadedP95TtftMs: number;
  readonly baselineAggregateTokensPerSecond: number;
  readonly loadedAggregateTokensPerSecond: number;
}

export interface ShadowProbePromotionThresholds {
  readonly minEvalCases: number;
  readonly minWeakBaselineCases: number;
  readonly minWeakDetectionRate: number;
  readonly maxFalsePositiveRate: number;
  readonly maxProbeErrorRate: number;
  readonly maxCapacitySkipRate: number;
  readonly maxP95TtftRegressionRatio: number;
  readonly maxAggregateThroughputRegressionRatio: number;
  readonly maxP95ProbeDurationMs: number;
  readonly maxOutputTokensPerSampledRun: number;
}

export interface ShadowProbePromotionReport {
  readonly allowed: boolean;
  readonly quality: {
    readonly totalCases: number;
    readonly weakCases: number;
    readonly detectedWeakCases: number;
    readonly weakDetectionRate: number | null;
    readonly healthyCases: number;
    readonly falsePositiveCases: number;
    readonly falsePositiveRate: number | null;
  };
  readonly load: {
    readonly completionRate: number | null;
    readonly probeErrorRate: number | null;
    readonly capacitySkipRate: number | null;
    readonly p95TtftRegressionRatio: number | null;
    readonly aggregateThroughputRegressionRatio: number | null;
    readonly outputTokensPerSampledRun: number | null;
  };
  readonly blockers: readonly string[];
}

export const DEFAULT_SHADOW_PROBE_PROMOTION_THRESHOLDS: ShadowProbePromotionThresholds = {
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
};

function ratio(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  return numerator / denominator;
}

function validateLoad(sample: ShadowProbeLoadSample): string[] {
  const values = Object.entries(sample);
  const invalid = values.filter(([, value]) => !Number.isFinite(value) || value < 0).map(([key]) => `invalid_load_metric:${key}`);
  if (sample.completedRuns + sample.capacitySkippedRuns + sample.probeErrors > sample.sampledRuns) invalid.push("load_outcome_count_exceeds_sampled_runs");
  return invalid;
}

export function evaluateShadowProbePromotion(
  cases: readonly ShadowProbeEvalCase[],
  load: ShadowProbeLoadSample,
  thresholds: ShadowProbePromotionThresholds = DEFAULT_SHADOW_PROBE_PROMOTION_THRESHOLDS
): ShadowProbePromotionReport {
  const blockers: string[] = [];
  blockers.push(...validateLoad(load));

  if (cases.length < thresholds.minEvalCases) blockers.push("insufficient_eval_cases");
  const weak = cases.filter((item) => item.expectedWeakBaseline);
  const healthy = cases.filter((item) => !item.expectedWeakBaseline);
  if (weak.length < thresholds.minWeakBaselineCases) blockers.push("insufficient_weak_baseline_cases");

  const detectedWeakCases = weak.filter((item) => item.verifierPassed === false || (item.verifierScore !== null && item.verifierScore < 70)).length;
  const falsePositiveCases = healthy.filter((item) => item.verifierPassed === false || (item.verifierScore !== null && item.verifierScore < 70)).length;
  const weakDetectionRate = ratio(detectedWeakCases, weak.length);
  const falsePositiveRate = ratio(falsePositiveCases, healthy.length);

  if (weakDetectionRate === null || weakDetectionRate < thresholds.minWeakDetectionRate) blockers.push("weak_detection_rate_below_threshold");
  if (falsePositiveRate === null || falsePositiveRate > thresholds.maxFalsePositiveRate) blockers.push("false_positive_rate_above_threshold");
  if (cases.some((item) => item.verifierPassed === null || item.verifierScore === null || item.reasonCode === "verifier_output_unparsed")) blockers.push("unparsed_or_incomplete_verifier_output");

  const completionRate = ratio(load.completedRuns, load.sampledRuns);
  const probeErrorRate = ratio(load.probeErrors, load.sampledRuns);
  const capacitySkipRate = ratio(load.capacitySkippedRuns, load.sampledRuns);
  const p95TtftRegressionRatio = load.baselineP95TtftMs > 0 ? (load.loadedP95TtftMs - load.baselineP95TtftMs) / load.baselineP95TtftMs : null;
  const aggregateThroughputRegressionRatio = load.baselineAggregateTokensPerSecond > 0
    ? (load.baselineAggregateTokensPerSecond - load.loadedAggregateTokensPerSecond) / load.baselineAggregateTokensPerSecond
    : null;
  const outputTokensPerSampledRun = ratio(load.totalProbeOutputTokens, load.sampledRuns);

  if (load.sampledRuns < 1) blockers.push("no_load_samples");
  if (probeErrorRate === null || probeErrorRate > thresholds.maxProbeErrorRate) blockers.push("probe_error_rate_above_threshold");
  if (capacitySkipRate === null || capacitySkipRate > thresholds.maxCapacitySkipRate) blockers.push("capacity_skip_rate_above_threshold");
  if (p95TtftRegressionRatio === null || p95TtftRegressionRatio > thresholds.maxP95TtftRegressionRatio) blockers.push("ttft_regression_above_threshold");
  if (aggregateThroughputRegressionRatio === null || aggregateThroughputRegressionRatio > thresholds.maxAggregateThroughputRegressionRatio) blockers.push("throughput_regression_above_threshold");
  if (!Number.isFinite(load.p95ProbeDurationMs) || load.p95ProbeDurationMs > thresholds.maxP95ProbeDurationMs) blockers.push("probe_duration_above_threshold");
  if (outputTokensPerSampledRun === null || outputTokensPerSampledRun > thresholds.maxOutputTokensPerSampledRun) blockers.push("probe_token_budget_above_threshold");

  return {
    allowed: blockers.length === 0,
    quality: {
      totalCases: cases.length,
      weakCases: weak.length,
      detectedWeakCases,
      weakDetectionRate,
      healthyCases: healthy.length,
      falsePositiveCases,
      falsePositiveRate
    },
    load: {
      completionRate,
      probeErrorRate,
      capacitySkipRate,
      p95TtftRegressionRatio,
      aggregateThroughputRegressionRatio,
      outputTokensPerSampledRun
    },
    blockers: [...new Set(blockers)]
  };
}
