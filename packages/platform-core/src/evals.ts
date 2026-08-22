export interface EvalMetric { key: string; score: number; minimum: number; critical?: boolean }
export interface PromotionInput {
  lifecycle: "registered" | "verified" | "canary";
  runtimePinned: boolean;
  artifactVerified: boolean;
  holdoutUntouched: boolean;
  metrics: EvalMetric[];
}

export function evaluatePromotion(input: PromotionInput): { allowed: boolean; next: "verified" | "canary" | "production"; blockers: string[] } {
  const blockers: string[] = [];
  if (!input.runtimePinned) blockers.push("runtime_not_pinned");
  if (!input.artifactVerified) blockers.push("artifact_not_verified");
  if (!input.holdoutUntouched) blockers.push("holdout_contaminated");
  for (const metric of input.metrics) if (metric.critical && metric.score < metric.minimum) blockers.push(`critical_eval_failed:${metric.key}`);
  const next = input.lifecycle === "registered" ? "verified" : input.lifecycle === "verified" ? "canary" : "production";
  return { allowed: blockers.length === 0, next, blockers };
}
