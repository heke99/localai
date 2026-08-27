import { describe, expect, it } from "vitest";
import type { TaskAnalysis } from "@div3rsa/agent-runtime";
import { evaluateResponseIntegrity, needsGroundedSynthesis } from "./response-integrity";

function task(overrides: Partial<TaskAnalysis> = {}): TaskAnalysis {
  return {
    primaryCategory: "research",
    categories: ["research"],
    risk: "low",
    complexity: "small",
    reasoningLevel: "fast",
    informationFreshness: "current",
    researchDepth: "fast",
    requiresCurrentInformation: true,
    requiresLiveData: false,
    liveDataKind: "external",
    affectedDomains: [],
    requiresRepository: false,
    requiresBrowser: false,
    requiresDatabase: false,
    requiresDeployment: false,
    requiresSecurityReview: false,
    verificationRequirements: ["current-information-evidence", "completion-proof"],
    project: {},
    ...overrides
  };
}

describe("response integrity", () => {
  it("rejects pseudo tool protocol in a final answer", () => {
    expect(evaluateResponseIntegrity("<tool_call><function=web_search>query=x</function></tool_call>", task()).passed).toBe(false);
  });

  it("rejects unfinished current research plans", () => {
    expect(evaluateResponseIntegrity("Let me open the official source next.", task()).passed).toBe(false);
  });

  it("rejects hidden reasoning markup", () => {
    expect(evaluateResponseIntegrity("<think>private</think>Final answer", task()).passed).toBe(false);
  });

  it("accepts a concrete grounded answer", () => {
    expect(evaluateResponseIntegrity("Node.js v24.7.0 is the verified current release according to https://nodejs.org/.", task()).passed).toBe(true);
  });

  it("requires a dedicated synthesis phase for external current information but not deterministic time", () => {
    expect(needsGroundedSynthesis("already good", task())).toBe(true);
    expect(needsGroundedSynthesis("already good", task({ requiresLiveData: true, liveDataKind: "time" }))).toBe(false);
  });
});
