import { createHash } from "node:crypto";

export interface VerifiedExperience {
  runId: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  verification: { passed: boolean; evidenceRefs: string[] };
  qualityScore: number;
  containsSecrets: boolean;
  userOptedOut: boolean;
  provenance: { organizationId: string; actorId: string; createdAt: string };
}

export interface DatasetExample { input: Record<string, unknown>; expected: Record<string, unknown>; provenance: Record<string, unknown> }

export function toDatasetCandidate(experience: VerifiedExperience, minimumQuality = 0.85): DatasetExample {
  if (!experience.verification.passed || experience.verification.evidenceRefs.length === 0) throw new Error("experience_not_verified");
  if (experience.qualityScore < minimumQuality) throw new Error("experience_quality_too_low");
  if (experience.containsSecrets) throw new Error("experience_contains_secrets");
  if (experience.userOptedOut) throw new Error("experience_opted_out");
  return { input: structuredClone(experience.input), expected: structuredClone(experience.output), provenance: { ...experience.provenance, runId: experience.runId, evidenceRefs: experience.verification.evidenceRefs } };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

export function buildDatasetVersion(examples: DatasetExample[]): { contentHash: string; examples: DatasetExample[] } {
  if (examples.length === 0) throw new Error("dataset_empty");
  const sorted = [...examples].sort((a, b) => canonical(a).localeCompare(canonical(b)));
  return { contentHash: createHash("sha256").update(canonical(sorted)).digest("hex"), examples: sorted };
}

export interface TrainingRequest {
  baseModelRevision: string;
  baseArtifactSha256: string;
  datasetHash: string;
  datasetStatus: "draft" | "verified" | "frozen";
  recipe: { method: "lora" | "qlora"; seed: number; epochs: number; learningRate: number };
  computePool: "inference" | "training";
}

export function validateTrainingRequest(request: TrainingRequest): void {
  if (!/^[a-f0-9]{40}$/.test(request.baseModelRevision)) throw new Error("base_model_revision_not_pinned");
  if (!/^[a-f0-9]{64}$/.test(request.baseArtifactSha256) || !/^[a-f0-9]{64}$/.test(request.datasetHash)) throw new Error("training_hash_invalid");
  if (request.datasetStatus !== "frozen") throw new Error("dataset_not_frozen");
  if (request.computePool !== "training") throw new Error("training_compute_must_be_separate");
  if (!Number.isInteger(request.recipe.seed) || request.recipe.epochs < 1 || request.recipe.learningRate <= 0) throw new Error("training_recipe_invalid");
}

export interface EvalComparison { key: string; baseline: number; candidate: number; maximumRegression: number; critical: boolean }
export function assertNoRegression(comparisons: EvalComparison[]): void {
  const failed = comparisons.filter((metric) => metric.critical && metric.baseline - metric.candidate > metric.maximumRegression);
  if (failed.length) throw new Error(`eval_regression:${failed.map((metric) => metric.key).join(",")}`);
}
