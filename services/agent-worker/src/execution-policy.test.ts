import { describe, expect, it } from "vitest";
import type { TaskAnalysis } from "@div3rsa/agent-runtime";
import { executionPolicyFor } from "./execution-policy";

function task(overrides: Partial<TaskAnalysis> = {}): TaskAnalysis {
  return {
    primaryCategory: "research",
    categories: ["research"],
    risk: "low",
    complexity: "small",
    reasoningLevel: "fast",
    informationFreshness: "stable",
    researchDepth: "none",
    requiresCurrentInformation: false,
    requiresLiveData: false,
    liveDataKind: null,
    affectedDomains: [],
    requiresRepository: false,
    requiresBrowser: false,
    requiresDatabase: false,
    requiresDeployment: false,
    requiresSecurityReview: false,
    verificationRequirements: ["completion-proof"],
    project: {},
    ...overrides
  };
}

describe("adaptive agent execution policy", () => {
  it("keeps stable read-only chat on a single bounded pass", () => {
    expect(executionPolicyFor(task())).toMatchObject({ tier: "FAST", verificationRounds: 1, maxToolIterations: 2, maxModelTurns: 3 });
  });

  it("fails fast for low-risk live data instead of multiplying model retries", () => {
    expect(executionPolicyFor(task({ requiresCurrentInformation: true, requiresLiveData: true, liveDataKind: "external", informationFreshness: "live", researchDepth: "fast" })))
      .toMatchObject({ tier: "FAST", verificationRounds: 1, maxToolIterations: 3, maxModelTurns: 4 });
  });

  it("allows enough tool turns for deep current corroboration without using the mutation budget", () => {
    expect(executionPolicyFor(task({ requiresCurrentInformation: true, informationFreshness: "current", researchDepth: "deep", reasoningLevel: "deep", complexity: "large" })))
      .toMatchObject({ tier: "DEEP", verificationRounds: 2, maxToolIterations: 6, maxModelTurns: 8 });
  });

  it("preserves the full verification budget for repository, database and deployment work", () => {
    expect(executionPolicyFor(task({ requiresRepository: true, risk: "medium" }))).toMatchObject({ tier: "STANDARD", verificationRounds: 3, maxToolIterations: 8, maxModelTurns: 12 });
    expect(executionPolicyFor(task({ requiresDatabase: true, risk: "critical" }))).toMatchObject({ tier: "CRITICAL", verificationRounds: 3, maxToolIterations: 8, maxModelTurns: 12 });
    expect(executionPolicyFor(task({ requiresDeployment: true, risk: "high" }))).toMatchObject({ tier: "DEEP", verificationRounds: 3, maxToolIterations: 8, maxModelTurns: 12 });
  });
});