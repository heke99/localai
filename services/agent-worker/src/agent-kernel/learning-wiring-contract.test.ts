import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("verified learning production wiring", () => {
  const source = readFileSync(new URL("../main.ts", import.meta.url), "utf8");

  it("keeps memory, learning and training eligibility disabled by default", () => {
    expect(source).toContain('booleanEnvironment("DIV3RSA_VERIFIED_MEMORY_ENABLED", false)');
    expect(source).toContain('booleanEnvironment("DIV3RSA_VERIFIED_LEARNING_ENABLED", false)');
    expect(source).toContain('booleanEnvironment("DIV3RSA_TRAINING_ELIGIBILITY_ENABLED", false)');
  });

  it("injects verified memory outside the active-canary adapter", () => {
    expect(source).toContain("const canaryAdapter: ModelAdapter = new AgentKernelActiveCanaryAdapter(inferenceAdapter, agentKernelConfig)");
    expect(source).toContain("new VerifiedMemoryAdapter(canaryAdapter, kernelStore, verifiedMemoryEnabled)");
  });

  it("records learning after rewind-aware verification is authoritative", () => {
    expect(source).toContain("const rewindQueue = new RewindAwareAgentQueue");
    expect(source).toContain("new VerifiedLearningAgentQueue(rewindQueue, kernelStore, verifiedLearningEnabled, trainingEligibilityEnabled)");
  });
});
