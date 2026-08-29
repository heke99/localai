import { createHash } from "node:crypto";
import type { VerifiedLearningDatasetManifest } from "./learning-export";

const SHA256 = /^[a-f0-9]{64}$/;

export interface OptimizationEvalSnapshot {
  readonly candidateId: string;
  readonly evalVersion: string;
  readonly evalSetDigest: string;
  readonly cases: number;
  readonly passed: number;
  readonly passRate: number;
  readonly allowed: boolean;
  readonly liveOracleFailures: readonly string[];
  readonly p95TtftMs?: number;
  readonly p95TotalMs?: number;
  readonly meanReward?: number;
}

export interface OptimizationCandidate {
  readonly candidateId: string;
  readonly promptVersion: string;
  readonly routingProfile: string;
}

export interface OptimizationPolicy {
  readonly minimumEvalCases: number;
  readonly maxTtftRegressionRatio: number;
  readonly maxTotalLatencyRegressionRatio: number;
  readonly maxRewardRegression: number;
}

export interface OptimizationDecision {
  readonly schemaVersion: 1;
  readonly datasetDigest: string;
  readonly evalSetDigest: string;
  readonly baselineCandidateId: string;
  readonly candidate: OptimizationCandidate;
  readonly allowed: boolean;
  readonly reasons: readonly string[];
  readonly decisionDigest: string;
}

export const DEFAULT_OPTIMIZATION_POLICY: OptimizationPolicy = {
  minimumEvalCases: 8,
  maxTtftRegressionRatio: 0.05,
  maxTotalLatencyRegressionRatio: 0.05,
  maxRewardRegression: 0
};

function finite(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validateSnapshot(snapshot: OptimizationEvalSnapshot): void {
  if (!snapshot.candidateId.trim() || !snapshot.evalVersion.trim()) throw new Error("invalid_optimization_eval_identity");
  if (!SHA256.test(snapshot.evalSetDigest)) throw new Error("invalid_optimization_eval_set_digest");
  if (!Number.isInteger(snapshot.cases) || snapshot.cases < 1) throw new Error("invalid_optimization_eval_cases");
  if (!Number.isInteger(snapshot.passed) || snapshot.passed < 0 || snapshot.passed > snapshot.cases) throw new Error("invalid_optimization_eval_passed");
  if (!Number.isFinite(snapshot.passRate) || snapshot.passRate < 0 || snapshot.passRate > 1) throw new Error("invalid_optimization_eval_pass_rate");
  if (Math.abs(snapshot.passRate - snapshot.passed / snapshot.cases) > 1e-9) throw new Error("inconsistent_optimization_eval_pass_rate");
  for (const value of [snapshot.p95TtftMs, snapshot.p95TotalMs]) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) throw new Error("invalid_optimization_eval_latency");
  }
  if (snapshot.meanReward !== undefined && !Number.isFinite(snapshot.meanReward)) throw new Error("invalid_optimization_eval_reward");
}

function exceedsRatio(candidate: number | undefined, baseline: number | undefined, ratio: number): boolean {
  if (!finite(candidate) || !finite(baseline)) return false;
  if (baseline === 0) return candidate > 0;
  return candidate > baseline * (1 + ratio);
}

export function evaluateOptimizationCandidate(input: {
  dataset: VerifiedLearningDatasetManifest;
  baseline: OptimizationEvalSnapshot;
  candidate: OptimizationEvalSnapshot;
  definition: OptimizationCandidate;
  policy?: Partial<OptimizationPolicy>;
}): OptimizationDecision {
  const policy: OptimizationPolicy = { ...DEFAULT_OPTIMIZATION_POLICY, ...input.policy };
  validateSnapshot(input.baseline);
  validateSnapshot(input.candidate);
  if (!SHA256.test(input.dataset.datasetDigest)) throw new Error("invalid_learning_dataset_digest");
  if (input.definition.candidateId !== input.candidate.candidateId) throw new Error("optimization_candidate_identity_mismatch");
  if (!input.definition.promptVersion.trim() || !input.definition.routingProfile.trim()) throw new Error("invalid_optimization_candidate_definition");
  if (policy.minimumEvalCases < 1 || policy.maxTtftRegressionRatio < 0 || policy.maxTotalLatencyRegressionRatio < 0 || policy.maxRewardRegression < 0) {
    throw new Error("invalid_optimization_policy");
  }

  const reasons: string[] = [];
  if (!input.dataset.readyForOptimization) reasons.push("insufficient_verified_learning_samples");
  if (input.baseline.evalVersion !== input.candidate.evalVersion) reasons.push("eval_version_mismatch");
  if (input.baseline.evalSetDigest !== input.candidate.evalSetDigest) reasons.push("eval_set_digest_mismatch");
  if (input.candidate.cases < policy.minimumEvalCases || input.candidate.cases < input.baseline.cases) reasons.push("insufficient_eval_coverage");
  if (!input.baseline.allowed) reasons.push("baseline_not_allowed");
  if (!input.candidate.allowed) reasons.push("candidate_not_allowed");
  if (input.candidate.liveOracleFailures.length > 0) reasons.push("live_oracle_failure");
  if (input.candidate.passRate < input.baseline.passRate) reasons.push("quality_regression");
  if (input.candidate.cases === input.baseline.cases && input.candidate.passed < input.baseline.passed) reasons.push("passed_case_regression");
  if (exceedsRatio(input.candidate.p95TtftMs, input.baseline.p95TtftMs, policy.maxTtftRegressionRatio)) reasons.push("ttft_regression");
  if (exceedsRatio(input.candidate.p95TotalMs, input.baseline.p95TotalMs, policy.maxTotalLatencyRegressionRatio)) reasons.push("total_latency_regression");
  if (finite(input.baseline.meanReward) && finite(input.candidate.meanReward) && input.candidate.meanReward < input.baseline.meanReward - policy.maxRewardRegression) {
    reasons.push("reward_regression");
  }
  if (input.definition.candidateId === input.baseline.candidateId) reasons.push("candidate_equals_baseline");

  const core = {
    schemaVersion: 1 as const,
    datasetDigest: input.dataset.datasetDigest,
    evalSetDigest: input.candidate.evalSetDigest,
    baselineCandidateId: input.baseline.candidateId,
    candidate: input.definition,
    allowed: reasons.length === 0,
    reasons
  };
  const decisionDigest = createHash("sha256").update(JSON.stringify(core)).digest("hex");
  return { ...core, decisionDigest };
}
