import { describe, expect, it, vi } from "vitest";
import type { TaskAnalysis } from "@div3rsa/agent-runtime";
import type { AgentKernelConfig } from "./config";
import { AgentKernelActiveCanaryRuntime } from "./active-canary";

const task = {
  categories: ["analysis"],
  risk: "medium",
  complexity: "moderate",
  reasoningLevel: "standard",
  informationFreshness: "stable",
  researchDepth: "none",
  requiresCurrentInformation: false,
  requiresLiveData: false,
  liveDataKind: null,
  requiresRepository: true,
  requiresBrowser: false,
  requiresDatabase: false,
  requiresDeployment: false,
  requiresSecurityReview: false,
  verificationRequirements: ["tests"]
} as unknown as TaskAnalysis;

const baseConfig: AgentKernelConfig = {
  enabled: true,
  mode: "active",
  maxSubagents: 4,
  maxParallelSubagents: 2,
  verificationRequired: true,
  activeCanaryBasisPoints: 10_000,
  activeTimeoutMsPerCall: 1_000,
  activeMaxOutputTokensPerCall: 128
};

describe("AgentKernelActiveCanaryRuntime", () => {
  it("runs bounded planner and analyst subagents for sampled active runs", async () => {
    const generate = vi.fn(async (input: { requestId: string }) => ({ content: input.requestId.includes("planner") ? "plan" : "risk analysis", usage: { outputTokens: 4 } }));
    const runtime = new AgentKernelActiveCanaryRuntime(baseConfig, { generate: generate as never });
    const result = await runtime.prepare({
      runId: "run-sampled",
      requestId: "req-1",
      modelAlias: "general-prod",
      prompt: "Analyze the repository safely",
      task,
      selectedSkills: ["repository-analysis"]
    });
    expect(result?.mode).toBe("active-canary");
    expect(result?.instruction).toContain("### planner");
    expect(result?.instruction).toContain("### analyst");
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("is a no-op unless active canary sampling is enabled", async () => {
    const generate = vi.fn();
    const runtime = new AgentKernelActiveCanaryRuntime({ ...baseConfig, mode: "shadow" }, { generate: generate as never });
    expect(await runtime.prepare({ runId: "run-1", requestId: "req-1", modelAlias: "general-prod", prompt: "x", task, selectedSkills: [] })).toBeNull();
    expect(generate).not.toHaveBeenCalled();
  });

  it("falls back to legacy context when a subagent call fails", async () => {
    const runtime = new AgentKernelActiveCanaryRuntime(baseConfig, { generate: vi.fn(async () => { throw new Error("timeout"); }) as never });
    expect(await runtime.prepare({ runId: "run-1", requestId: "req-1", modelAlias: "general-prod", prompt: "x", task, selectedSkills: [] })).toBeNull();
  });
});
