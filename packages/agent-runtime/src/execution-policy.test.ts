import { describe, expect, it } from "vitest";
import { executionPolicyFor } from "./execution-policy";
import { analyzeTask } from "./task-analyzer";

describe("execution policy v2", () => {
  it("keeps trivial stable work on a fast bounded budget", () => {
    const policy = executionPolicyFor(analyzeTask("chat", "Förklara Pythagoras sats enkelt."));
    expect(policy.tier).toBe("FAST");
    expect(policy).toMatchObject({ verificationRounds: 1, maxToolIterations: 2, maxModelTurns: 3, maxContextTokens: 8_000, repoDepth: "none", researchDepth: "none" });
  });

  it("keeps deterministic live lookups fast while allowing the required tool", () => {
    const policy = executionPolicyFor(analyzeTask("chat", "Vilken tid är det i Stockholm just nu?"));
    expect(policy.tier).toBe("FAST");
    expect(policy).toMatchObject({ verificationRounds: 1, maxToolIterations: 3, maxModelTurns: 4, researchDepth: "fast" });
    expect(policy.allowedToolGroups).toContain("live");
  });

  it("allocates standard context and verification for ordinary repository work", () => {
    const policy = executionPolicyFor(analyzeTask("code", "Fix login bug in this repository"));
    expect(policy.tier).toBe("STANDARD");
    expect(policy.maxContextTokens).toBe(16_000);
    expect(policy.repoDepth).toBe("dependency");
    expect(policy.requiredVerifiers).toEqual(expect.arrayContaining(["consequence-analysis", "targeted-tests", "completion-proof"]));
  });

  it("allows five sequential dependent tool calls plus a final turn for explicit deep work", () => {
    const policy = executionPolicyFor(analyzeTask("chat", "Run this end-to-end long-horizon task and follow every dependent step."));
    expect(policy.tier).toBe("DEEP");
    expect(policy).toMatchObject({ verificationRounds: 2, maxToolIterations: 6, maxModelTurns: 8, maxContextTokens: 32_000 });
  });

  it("allocates a critical budget to production database deployment work", () => {
    const policy = executionPolicyFor(analyzeTask("code", "Migrate the production database RLS policy and deploy it"));
    expect(policy.tier).toBe("CRITICAL");
    expect(policy.maxContextTokens).toBe(48_000);
    expect(policy.allowedToolGroups).toEqual(expect.arrayContaining(["repository", "database", "deployment"]));
    expect(policy.requiredVerifiers).toEqual(expect.arrayContaining(["database-invariants", "security-review", "deployment-health", "completion-proof"]));
  });
});
