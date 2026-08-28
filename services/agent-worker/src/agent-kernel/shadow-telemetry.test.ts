import { describe, expect, it, vi } from "vitest";
import type { TaskAnalysis } from "@div3rsa/agent-runtime";
import type { AgentKernelConfig } from "./config";
import { AgentKernelShadowTelemetry, type LegacyExecutionSnapshot } from "./shadow-telemetry";

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

const baseline: LegacyExecutionSnapshot = {
  executionTier: "standard",
  repoDepth: "none",
  verificationRounds: 1,
  selectedSkills: ["general-reasoning"],
  toolNames: []
};

function input(overrides: Record<string, unknown> = {}) {
  return {
    runId: "run-shadow-telemetry",
    conversationId: "conversation-1",
    mode: "chat",
    modelAlias: "general-prod" as const,
    objective: "Answer the user accurately",
    task: task(),
    availableToolNames: [],
    requestedAt: "2026-08-29T12:00:00.000Z",
    ...overrides
  };
}

describe("AgentKernelShadowTelemetry", () => {
  it("is a no-op unless shadow mode is explicitly enabled", async () => {
    const record = vi.fn(async () => undefined);
    const telemetry = new AgentKernelShadowTelemetry(config({ enabled: false, mode: "legacy" }), { record });
    await expect(telemetry.observe(input(), baseline)).resolves.toEqual({ status: "skipped" });
    expect(record).not.toHaveBeenCalled();
  });

  it("persists a redacted structural observation without prompt/objective text", async () => {
    const record = vi.fn(async () => undefined);
    const telemetry = new AgentKernelShadowTelemetry(config(), { record });
    const outcome = await telemetry.observe(input({
      objective: "SECRET USER PROMPT",
      task: task({ requiresCurrentInformation: true, researchDepth: "deep" }),
      availableToolNames: ["web_search", "web_fetch"]
    }), { ...baseline, toolNames: ["web_search", "web_fetch"] });

    expect(outcome.status).toBe("observed");
    expect(record).toHaveBeenCalledOnce();
    const serialized = JSON.stringify(record.mock.calls[0]?.[1]);
    expect(serialized).not.toContain("SECRET USER PROMPT");
    expect(serialized).toContain("research");
  });

  it("compares the shadow plan against legacy execution expectations", async () => {
    const record = vi.fn(async () => undefined);
    const telemetry = new AgentKernelShadowTelemetry(config(), { record });
    const outcome = await telemetry.observe(input({ task: task({ requiresRepository: true }) }), {
      ...baseline,
      repoDepth: "dependency",
      toolNames: ["repository.inspect"]
    });
    expect(outcome.status).toBe("observed");
    if (outcome.status !== "observed") throw new Error("expected_observed");
    expect(outcome.state.comparison.aligned).toBe(true);
    expect(outcome.state.plan.steps.map((step) => step.id)).toEqual(["plan", "execute", "verify"]);
  });

  it("contains persistence failures instead of throwing into the legacy path", async () => {
    const telemetry = new AgentKernelShadowTelemetry(config(), { record: vi.fn(async () => { throw new Error("telemetry_db_unavailable"); }) });
    await expect(telemetry.observe(input(), baseline)).resolves.toEqual({
      status: "persistence_error",
      errorCode: "telemetry_db_unavailable"
    });
  });

  it("contains planning failures instead of throwing into the legacy path", async () => {
    const telemetry = new AgentKernelShadowTelemetry(config({ maxSubagents: 2 }), { record: vi.fn(async () => undefined) });
    const outcome = await telemetry.observe(input({ task: task({ requiresRepository: true }) }), baseline);
    expect(outcome.status).toBe("planning_error");
  });
});
