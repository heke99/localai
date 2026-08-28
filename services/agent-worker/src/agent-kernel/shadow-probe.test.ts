import { describe, expect, it, vi } from "vitest";
import type { TaskAnalysis } from "@div3rsa/agent-runtime";
import { AgentKernelShadowProbeRunner, deterministicProbeSample } from "./shadow-probe";
import type { AgentKernelShadowProbeConfig } from "./shadow-probe-config";

function config(overrides: Partial<AgentKernelShadowProbeConfig> = {}): AgentKernelShadowProbeConfig {
  return {
    enabled: true,
    sampleBasisPoints: 10_000,
    maxConcurrent: 1,
    maxCallsPerRun: 3,
    maxOutputTokensPerCall: 128,
    timeoutMsPerCall: 2_000,
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
    runId: "run-probe-1",
    requestId: "request-probe-1",
    modelAlias: "general-prod" as const,
    prompt: "Explain the current rule and cite evidence",
    baselineAnswer: "Baseline answer",
    task: task(),
    selectedSkills: ["general-reasoning"],
    ...overrides
  };
}

describe("AgentKernelShadowProbeRunner", () => {
  it("uses deterministic sampling", () => {
    expect(deterministicProbeSample("same-run", 0)).toBe(false);
    expect(deterministicProbeSample("same-run", 10_000)).toBe(true);
    expect(deterministicProbeSample("same-run", 250)).toBe(deterministicProbeSample("same-run", 250));
  });

  it("does not call the model when disabled or not sampled", async () => {
    const generate = vi.fn();
    await expect(new AgentKernelShadowProbeRunner(config({ enabled: false }), { generate }).run(input())).resolves.toEqual({ status: "disabled" });
    expect(generate).not.toHaveBeenCalled();
  });

  it("runs planner and verifier without tools and persists only structural metadata", async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce({ content: "plan output", usage: { inputTokens: 10, outputTokens: 3 } })
      .mockResolvedValueOnce({ content: JSON.stringify({ score: 88, passed: true, reasonCode: "baseline_supported" }), usage: { inputTokens: 12, outputTokens: 4 } });
    const outcome = await new AgentKernelShadowProbeRunner(config(), { generate }).run(input());
    expect(outcome.status).toBe("completed");
    expect(generate).toHaveBeenCalledTimes(2);
    for (const call of generate.mock.calls) {
      expect(call[0]).not.toHaveProperty("tools");
      expect(call[0].maxOutputTokens).toBe(128);
      expect(call[0].signal).toBeInstanceOf(AbortSignal);
    }
    if (outcome.status !== "completed") throw new Error("expected_completed");
    expect(outcome.observation.quality).toEqual({ score: 88, passed: true, reasonCode: "baseline_supported" });
    expect(JSON.stringify(outcome.observation)).not.toContain("plan output");
    expect(JSON.stringify(outcome.observation)).not.toContain("Baseline answer");
  });

  it("adds a tool-free researcher only when current evidence is needed", async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce({ content: "plan" })
      .mockResolvedValueOnce({ content: "research requirements" })
      .mockResolvedValueOnce({ content: JSON.stringify({ score: 70, passed: false, reasonCode: "missing_evidence" }) });
    const outcome = await new AgentKernelShadowProbeRunner(config(), { generate }).run(input({
      task: task({ requiresCurrentInformation: true, researchDepth: "deep", informationFreshness: "current" })
    }));
    expect(outcome.status).toBe("completed");
    expect(generate).toHaveBeenCalledTimes(3);
    if (outcome.status !== "completed") throw new Error("expected_completed");
    expect(outcome.observation.calls.map((call) => call.role)).toEqual(["planner", "researcher", "verifier"]);
  });

  it("contains model failures instead of throwing", async () => {
    const generate = vi.fn(async () => { throw new Error("probe_model_unavailable"); });
    await expect(new AgentKernelShadowProbeRunner(config(), { generate }).run(input())).resolves.toEqual({
      status: "probe_error",
      errorCode: "probe_model_unavailable"
    });
  });

  it("skips excess concurrent probes instead of queueing extra GPU work", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const generate = vi.fn(async () => { await gate; return { content: "plan" }; });
    const runner = new AgentKernelShadowProbeRunner(config({ maxCallsPerRun: 1 }), { generate });
    const first = runner.run(input({ runId: "run-a" }));
    await Promise.resolve();
    await expect(runner.run(input({ runId: "run-b" }))).resolves.toEqual({ status: "capacity_skipped" });
    release();
    await expect(first).resolves.toMatchObject({ status: "completed" });
  });
});
