import { describe, expect, it } from "vitest";
import { buildTrajectory, rewardFromSignals, trajectoryEligibleForTraining } from "./trajectory";

describe("Agent Kernel trajectories", () => {
  it("scores the canonical reward signals", () => {
    expect(rewardFromSignals({ exactOracleCorrect: true, allTestsPass: true, userAccepted: true, lowerLatency: true })).toBe(14);
    expect(rewardFromSignals({ independentVerificationPassed: true })).toBe(5);
    expect(rewardFromSignals({ hallucination: true, regression: true, unnecessarySearch: true })).toBe(-13);
  });

  it("allows training only from positively rewarded verified traces", () => {
    const trajectory = buildTrajectory({
      agentRunId: "run-1",
      modelVersion: "qwen-v3-q8",
      promptVersion: "kernel-v2",
      signals: { independentVerificationPassed: true, allTestsPass: true },
      steps: [{ step: 1, reasoningMode: "standard", tool: "test", argumentsDigest: null, resultDigest: null, latencyMs: 10, tokens: 10, cachedTokens: 0, sourceQuality: 1, testsBefore: 1, testsAfter: 1, verificationResult: "passed" }]
    });
    expect(trajectory.reward).toBe(10);
    expect(trajectoryEligibleForTraining(trajectory)).toBe(true);
  });

  it("blocks traces containing failed verification", () => {
    const trajectory = buildTrajectory({
      agentRunId: "run-2",
      modelVersion: "qwen-v3-q8",
      promptVersion: "kernel-v2",
      signals: { independentVerificationPassed: true, allTestsPass: true },
      steps: [{ step: 1, reasoningMode: "standard", tool: null, argumentsDigest: null, resultDigest: null, latencyMs: 10, tokens: 10, cachedTokens: 0, sourceQuality: null, testsBefore: null, testsAfter: null, verificationResult: "failed" }]
    });
    expect(trajectoryEligibleForTraining(trajectory)).toBe(false);
  });
});
