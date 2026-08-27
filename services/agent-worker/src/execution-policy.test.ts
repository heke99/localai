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
    expect(executionPolicyFor(task())).toEqual({ verificationRounds: 1, maxToolIterations: 2, maxModelTurns: 3 });
  });

  it("fails fast for low-risk live data instead of multiplying model retries", () => {
    expect(executionPolicyFor(task({ requiresCurrentInformation: true, requiresLiveData: true, informationFreshness: "live", researchDepth: "fast" })))
      .toEqual({ verificationRounds: 1, maxToolIterations: 3, maxModelTurns: 4 });
  });

  it("allows enough tool turns for deep current corroboration without using the mutation budget", () => {
    expect(executionPolicyFor(task({ requiresCurrentInformation: true, informationFreshness: "current", researchDepth: "deep", reasoningLevel: "deep", complexity: "large" })))
      .toEqual({ verificationRounds: 2, maxToolIterations: 6, maxModelTurns: 8 });
  });

  it("preserves the full verification budget for repository, database and deployment work", () => {
    expect(executionPolicyFor(task({ requiresRepository: true, risk: "medium" }))).toEqual({ verificationRounds: 3, maxToolIterations: 8, maxModelTurns: 12 });
    expect(executionPolicyFor(task({ requiresDatabase: true, risk: "critical" }))).toEqual({ verificationRounds: 3, maxToolIterations: 8, maxModelTurns: 12 });
    expect(executionPolicyFor(task({ requiresDeployment: true, risk: "high" }))).toEqual({ verificationRounds: 3, maxToolIterations: 8, maxModelTurns: 12 });
  });
});
