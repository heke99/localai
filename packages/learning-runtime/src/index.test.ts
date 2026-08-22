import { describe, expect, it } from "vitest";
import { assertNoRegression, buildDatasetVersion, toDatasetCandidate, validateTrainingRequest } from "./index";

const experience = { runId: "r", input: { prompt: "x" }, output: { answer: "y" }, verification: { passed: true, evidenceRefs: ["test:1"] }, qualityScore: 0.95, containsSecrets: false, userOptedOut: false, provenance: { organizationId: "o", actorId: "u", createdAt: "2026-01-01T00:00:00Z" } };

describe("learning runtime", () => {
  it("only builds candidates from verified, consented, secret-free experiences", () => {
    expect(toDatasetCandidate(experience).provenance.runId).toBe("r");
    expect(() => toDatasetCandidate({ ...experience, containsSecrets: true })).toThrow("experience_contains_secrets");
  });
  it("produces stable dataset hashes independent of input order", () => {
    const one = toDatasetCandidate(experience);
    const two = { ...one, input: { prompt: "z" } };
    expect(buildDatasetVersion([one, two]).contentHash).toBe(buildDatasetVersion([two, one]).contentHash);
  });
  it("separates training compute and requires frozen data", () => {
    expect(() => validateTrainingRequest({ baseModelRevision: "a".repeat(40), baseArtifactSha256: "b".repeat(64), datasetHash: "c".repeat(64), datasetStatus: "frozen", recipe: { method: "qlora", seed: 42, epochs: 1, learningRate: 0.0001 }, computePool: "inference" })).toThrow("training_compute_must_be_separate");
  });
  it("blocks critical regressions", () => {
    expect(() => assertNoRegression([{ key: "coding", baseline: 0.9, candidate: 0.7, maximumRegression: 0.05, critical: true }])).toThrow("eval_regression:coding");
  });
});
