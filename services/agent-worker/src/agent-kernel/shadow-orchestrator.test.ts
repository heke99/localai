import { describe, expect, it } from "vitest";
import type { TaskAnalysis } from "@div3rsa/agent-runtime";
import { AgentKernelShadowOrchestrator, parallelWavesFor } from "./shadow-orchestrator";
import type { AgentKernelConfig } from "./config";

function config(overrides: Partial<AgentKernelConfig> = {}): AgentKernelConfig {
  return {
    enabled: true,
    mode: "shadow",
    maxSubagents: 4,
    maxParallelSubagents: 2,
    verificationRequired: true,
    ...overrides
  };
}

function task(overrides: Partial<TaskAnalysis> = {}): TaskAnalysis {
  return {
    primaryCategory: "research",
    categories: ["research"],
    risk: "low",
    complexity: "small",
    reasoningLevel: "standard",
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

function input(overrides: Record<string, unknown> = {}) {
  return {
    runId: "run-shadow-1",
    conversationId: "conversation-1",
    mode: "code",
    modelAlias: "general-prod" as const,
    objective: "Inspect and safely improve the repository",
    task: task(),
    availableToolNames: ["github.read"],
    requestedAt: "2026-08-29T12:00:00.000Z",
    ...overrides
  };
}

describe("Agent Kernel V2 shadow orchestrator", () => {
  it("is a strict no-op when V2 is disabled or not in shadow mode", () => {
    expect(new AgentKernelShadowOrchestrator(config({ enabled: false, mode: "legacy" })).observe(input())).toBeNull();
    expect(new AgentKernelShadowOrchestrator(config({ mode: "active" })).observe(input())).toBeNull();
  });

  it("plans repository work without invoking any model or tool runtime", () => {
    const observation = new AgentKernelShadowOrchestrator(config()).observe(input({
      task: task({ requiresRepository: true, complexity: "large", reasoningLevel: "deep" })
    }));

    expect(observation?.plan.agents.map((agent) => agent.agentId)).toEqual(["planner", "executor", "verifier"]);
    expect(observation?.plan.steps.map((step) => step.id)).toEqual(["plan", "execute", "verify"]);
    expect(observation?.plan.finalVerifierAgentId).toBe("verifier");
    expect(observation?.parallelWaves).toEqual([["plan"], ["execute"], ["verify"]]);
  });

  it("exposes independent research and execution as the same bounded parallel wave", () => {
    const observation = new AgentKernelShadowOrchestrator(config()).observe(input({
      task: task({
        requiresCurrentInformation: true,
        informationFreshness: "current",
        researchDepth: "deep",
        requiresRepository: true,
        complexity: "large"
      }),
      availableToolNames: ["web_search", "web_fetch", "repository.inspect"]
    }));

    expect(observation?.plan.steps.map((step) => step.id)).toEqual(["plan", "research", "execute", "verify"]);
    expect(observation?.parallelWaves).toEqual([["plan"], ["execute", "research"], ["verify"]]);
    expect(observation?.metrics.maxParallelWidth).toBe(2);
  });

  it("fails closed when the subagent budget cannot retain the mandatory verifier", () => {
    expect(() => new AgentKernelShadowOrchestrator(config({ maxSubagents: 2, maxParallelSubagents: 2 })).observe(input({
      task: task({ requiresRepository: true })
    }))).toThrow(/budget_missing_verifier/);
  });

  it("never schedules more work in a wave than the configured parallel budget", () => {
    const observation = new AgentKernelShadowOrchestrator(config({ maxParallelSubagents: 1 })).observe(input({
      task: task({ requiresCurrentInformation: true, researchDepth: "deep", requiresRepository: true }),
      availableToolNames: ["web_search", "repository.inspect"]
    }));
    expect(observation).not.toBeNull();
    expect(observation!.parallelWaves.every((wave) => wave.length <= 1)).toBe(true);
  });

  it("rejects an impossible scheduler input instead of spinning", () => {
    const observation = new AgentKernelShadowOrchestrator(config()).observe(input({ task: task({ requiresRepository: true }) }));
    const cyclic = {
      ...observation!.plan,
      steps: observation!.plan.steps.map((step) => step.id === "plan" ? { ...step, dependsOn: ["verify"] } : step)
    };
    expect(() => parallelWavesFor(cyclic, 2)).toThrow(/no_runnable_steps/);
  });
});
