import { describe, expect, it } from "vitest";
import { memoryIsEligibleForPlanning, promoteVerifiedExperience, proceduralMemory } from "./verified-experience";

describe("verified experience memory", () => {
  it("promotes only evidence-backed regression-free verified experience", () => {
    const memory = promoteVerifiedExperience({
      sourceRunId: "run-1",
      scope: "gridex",
      problem: "Node current lookup returned stale data",
      successfulStrategy: "official source -> exact semver oracle -> fail closed",
      evidenceRefs: ["eval:8/8", "oracle:node"],
      verificationPassed: true,
      regressionFree: true,
      sourceQuality: 1
    });
    expect(memory?.tier).toBe("verified_experience");
    expect(memoryIsEligibleForPlanning(memory!)).toBe(true);
  });

  it("rejects failed or weakly sourced experience", () => {
    expect(promoteVerifiedExperience({ sourceRunId: "r", scope: "x", problem: "p", successfulStrategy: "s", evidenceRefs: [], verificationPassed: true, regressionFree: true })).toBeNull();
    expect(promoteVerifiedExperience({ sourceRunId: "r", scope: "x", problem: "p", successfulStrategy: "s", evidenceRefs: ["e"], verificationPassed: false, regressionFree: true })).toBeNull();
  });

  it("requires verification before procedural memory can guide planning", () => {
    const draft = proceduralMemory({ sourceRunId: "r", scope: "gridex", procedure: "verify readiness after switch changes" })!;
    const verified = proceduralMemory({ sourceRunId: "r", scope: "gridex", procedure: "verify readiness after switch changes", verified: true, evidenceRefs: ["test"] })!;
    expect(memoryIsEligibleForPlanning(draft)).toBe(false);
    expect(memoryIsEligibleForPlanning(verified)).toBe(true);
  });
});
