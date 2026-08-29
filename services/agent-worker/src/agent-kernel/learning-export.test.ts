import { describe, expect, it } from "vitest";
import { buildVerifiedLearningDatasetManifest, type VerifiedLearningExportEnvelope } from "./learning-export";

const digestA = "a".repeat(64);
const digestB = "b".repeat(64);
const trajectoryA = "1".repeat(64);
const trajectoryB = "2".repeat(64);

function envelope(records = 2): VerifiedLearningExportEnvelope {
  const all = [
    {
      trajectoryId: trajectoryA,
      modelVersion: "qwen38-v3-q8",
      promptVersion: "kernel-v2",
      steps: [{ step: 0, reasoningMode: "code", tool: "github_read_file", argumentsDigest: digestA, resultDigest: digestB, latencyMs: 10, tokens: 20, cachedTokens: 5, sourceQuality: 1, testsBefore: 1, testsAfter: 2, verificationResult: "passed" as const }],
      userFeedback: "accepted" as const,
      reward: 10,
      createdAt: "2026-08-29T20:00:00.000Z"
    },
    {
      trajectoryId: trajectoryB,
      modelVersion: "qwen38-v3-q8",
      promptVersion: "kernel-v2",
      steps: [{ step: 0, reasoningMode: "research", tool: "web_search", argumentsDigest: digestB, resultDigest: digestA, latencyMs: 15, tokens: 30, cachedTokens: 6, sourceQuality: 0.9, testsBefore: null, testsAfter: null, verificationResult: "passed" as const }],
      userFeedback: "unknown" as const,
      reward: 7,
      createdAt: "2026-08-29T20:01:00.000Z"
    }
  ];
  return { schemaVersion: 1, queryVersion: "verified-learning-v1", createdBefore: "2026-08-29T21:00:00.000Z", minReward: 1, records: all.slice(0, records) };
}

describe("verified learning export", () => {
  it("builds a deterministic content digest independent of generation time", () => {
    const first = buildVerifiedLearningDatasetManifest(envelope(), { minimumSamples: 2, generatedAt: "2026-08-29T22:00:00.000Z" });
    const second = buildVerifiedLearningDatasetManifest(envelope(), { minimumSamples: 2, generatedAt: "2026-08-29T23:00:00.000Z" });
    expect(first.datasetDigest).toBe(second.datasetDigest);
    expect(first.readyForOptimization).toBe(true);
    expect(first.recordCount).toBe(2);
  });

  it("does not mark an undersized verified dataset ready", () => {
    const manifest = buildVerifiedLearningDatasetManifest(envelope(1), { minimumSamples: 2 });
    expect(manifest.readyForOptimization).toBe(false);
  });

  it("rejects failed verification even if the database envelope claims it is exported", () => {
    const source = envelope();
    const poisoned: VerifiedLearningExportEnvelope = {
      ...source,
      records: [{ ...source.records[0]!, steps: [{ ...source.records[0]!.steps[0]!, verificationResult: "failed" }] }]
    };
    expect(() => buildVerifiedLearningDatasetManifest(poisoned)).toThrow("unverified_learning_record");
  });

  it("rejects non-digest argument or result payloads", () => {
    const source = envelope();
    const raw: VerifiedLearningExportEnvelope = {
      ...source,
      records: [{ ...source.records[0]!, steps: [{ ...source.records[0]!.steps[0]!, argumentsDigest: "raw prompt text" }] }]
    };
    expect(() => buildVerifiedLearningDatasetManifest(raw)).toThrow("invalid_learning_record_arguments_digest");
  });

  it("requires deterministic database ordering", () => {
    const source = envelope();
    expect(() => buildVerifiedLearningDatasetManifest({ ...source, records: [...source.records].reverse() })).toThrow("learning_export_not_deterministically_ordered");
  });
});
