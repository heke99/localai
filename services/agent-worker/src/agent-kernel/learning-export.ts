import { createHash } from "node:crypto";
import type { AgentTrajectoryStep } from "./trajectory";

const SHA256 = /^[a-f0-9]{64}$/;

export interface VerifiedLearningRecord {
  readonly trajectoryId: string;
  readonly modelVersion: string;
  readonly promptVersion: string;
  readonly steps: readonly AgentTrajectoryStep[];
  readonly userFeedback: "accepted" | "rejected" | "unknown";
  readonly reward: number;
  readonly createdAt: string;
}

export interface VerifiedLearningExportEnvelope {
  readonly schemaVersion: 1;
  readonly queryVersion: "verified-learning-v1";
  readonly createdBefore: string;
  readonly minReward: number;
  readonly records: readonly VerifiedLearningRecord[];
}

export interface VerifiedLearningDatasetManifest {
  readonly schemaVersion: 1;
  readonly queryVersion: "verified-learning-v1";
  readonly generatedAt: string;
  readonly createdBefore: string;
  readonly minReward: number;
  readonly minimumSamples: number;
  readonly recordCount: number;
  readonly readyForOptimization: boolean;
  readonly datasetDigest: string;
  readonly records: readonly VerifiedLearningRecord[];
}

function requireFiniteNonNegative(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`invalid_learning_record_${field}`);
}

function validateStep(step: AgentTrajectoryStep): void {
  if (!Number.isInteger(step.step) || step.step < 0) throw new Error("invalid_learning_record_step");
  if (!step.reasoningMode.trim()) throw new Error("invalid_learning_record_reasoning_mode");
  if (step.argumentsDigest !== null && !SHA256.test(step.argumentsDigest)) throw new Error("invalid_learning_record_arguments_digest");
  if (step.resultDigest !== null && !SHA256.test(step.resultDigest)) throw new Error("invalid_learning_record_result_digest");
  requireFiniteNonNegative(step.latencyMs, "latency");
  requireFiniteNonNegative(step.tokens, "tokens");
  requireFiniteNonNegative(step.cachedTokens, "cached_tokens");
  if (step.sourceQuality !== null && (!Number.isFinite(step.sourceQuality) || step.sourceQuality < 0 || step.sourceQuality > 1)) {
    throw new Error("invalid_learning_record_source_quality");
  }
  if (step.verificationResult === "failed") throw new Error("unverified_learning_record");
}

export function assertVerifiedLearningRecord(record: VerifiedLearningRecord): void {
  if (!SHA256.test(record.trajectoryId)) throw new Error("invalid_learning_record_id");
  if (!record.modelVersion.trim() || !record.promptVersion.trim()) throw new Error("invalid_learning_record_version");
  if (!Number.isInteger(record.reward) || record.reward <= 0 || record.reward > 1000) throw new Error("invalid_learning_record_reward");
  if (!Array.isArray(record.steps) || record.steps.length === 0) throw new Error("invalid_learning_record_steps");
  for (const step of record.steps) validateStep(step);
  if (!record.steps.some((step) => step.verificationResult === "passed")) throw new Error("learning_record_requires_passed_verification");
  if (!Number.isFinite(Date.parse(record.createdAt))) throw new Error("invalid_learning_record_created_at");
}

function datasetDigest(envelope: VerifiedLearningExportEnvelope): string {
  return createHash("sha256").update(JSON.stringify({
    schemaVersion: envelope.schemaVersion,
    queryVersion: envelope.queryVersion,
    createdBefore: envelope.createdBefore,
    minReward: envelope.minReward,
    records: envelope.records
  })).digest("hex");
}

export function buildVerifiedLearningDatasetManifest(
  envelope: VerifiedLearningExportEnvelope,
  options: { minimumSamples?: number; generatedAt?: string } = {}
): VerifiedLearningDatasetManifest {
  if (envelope.schemaVersion !== 1 || envelope.queryVersion !== "verified-learning-v1") throw new Error("unsupported_learning_export_schema");
  if (!Number.isFinite(Date.parse(envelope.createdBefore))) throw new Error("invalid_learning_export_cutoff");
  if (!Number.isInteger(envelope.minReward) || envelope.minReward < 1 || envelope.minReward > 1000) throw new Error("invalid_learning_export_min_reward");

  const minimumSamples = Math.max(1, Math.min(5000, Math.floor(options.minimumSamples ?? 25)));
  const records = [...envelope.records];
  for (const record of records) assertVerifiedLearningRecord(record);
  for (let index = 1; index < records.length; index += 1) {
    const previous = records[index - 1]!;
    const current = records[index]!;
    const previousKey = `${previous.createdAt}:${previous.trajectoryId}`;
    const currentKey = `${current.createdAt}:${current.trajectoryId}`;
    if (previousKey > currentKey) throw new Error("learning_export_not_deterministically_ordered");
  }
  if (new Set(records.map((record) => record.trajectoryId)).size !== records.length) throw new Error("duplicate_learning_trajectory");

  return {
    schemaVersion: 1,
    queryVersion: "verified-learning-v1",
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    createdBefore: envelope.createdBefore,
    minReward: envelope.minReward,
    minimumSamples,
    recordCount: records.length,
    readyForOptimization: records.length >= minimumSamples,
    datasetDigest: datasetDigest({ ...envelope, records }),
    records
  };
}
