import { describe, expect, it, vi } from "vitest";
import type { AgentQueue, ClaimedRun } from "../processor";
import type { TaskAnalysis } from "@div3rsa/agent-runtime";
import type { AgentKernelConfig } from "./config";
import { AgentKernelShadowQueue } from "./shadow-queue";

const run: ClaimedRun = {
  jobId: "job-1",
  runId: "run-1",
  mode: "code",
  modelAlias: "general-prod",
  prompt: "Inspect the repository",
  requestId: "request-1",
  traceId: "trace-1",
  resourceContext: []
};

function config(overrides: Partial<AgentKernelConfig> = {}): AgentKernelConfig {
  return {
    enabled: true,
    mode: "shadow",
    maxSubagents: 4,
    maxParallelSubagents: 2,
    verificationRequired: true,
    activeCanaryBasisPoints: 0,
    activeTimeoutMsPerCall: 4_000,
    activeMaxOutputTokensPerCall: 384,
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

function innerQueue() {
  return {
    claim: vi.fn(async () => run),
    step: vi.fn(async (_runId: string, _kind: string, _status: string, _summary: string, _state?: Record<string, unknown>) => undefined),
    stream: vi.fn(async (_runId: string, _delta: string, _reset?: boolean) => undefined),
    recordRunIntelligence: vi.fn(async (_runId: string, _task: TaskAnalysis, _skills: string[]) => undefined),
    recordRepositoryIndex: vi.fn(async () => "index-1"),
    recordImpactAnalysis: vi.fn(async () => "impact-1"),
    recordVerificationRun: vi.fn(async () => "verification-1"),
    complete: vi.fn(async () => undefined),
    fail: vi.fn(async () => undefined),
    isCancelled: vi.fn(async () => false)
  };
}

function wrapped(inner: ReturnType<typeof innerQueue>, kernelConfig = config()) {
  return new AgentKernelShadowQueue(inner as unknown as AgentQueue, kernelConfig);
}

describe("AgentKernelShadowQueue", () => {
  it("delegates legacy queue behavior and records one structural shadow step", async () => {
    const inner = innerQueue();
    const queue = wrapped(inner);
    await expect(queue.claim("worker-1")).resolves.toEqual(run);
    await expect(queue.recordRunIntelligence(run.runId, task({ requiresRepository: true }), ["repo-safety"])).resolves.toBeUndefined();

    expect(inner.recordRunIntelligence).toHaveBeenCalledOnce();
    const shadowCalls = inner.step.mock.calls.filter((call) => call[1] === "agent_kernel_shadow");
    expect(shadowCalls).toHaveLength(1);
    expect(shadowCalls[0]?.[2]).toBe("observed");
    const serialized = JSON.stringify(shadowCalls[0]?.[4]);
    expect(serialized).not.toContain(run.prompt);
    expect(serialized).toContain("repo-safety");
  });

  it("does not emit shadow telemetry when V2 is disabled", async () => {
    const inner = innerQueue();
    const queue = wrapped(inner, config({ enabled: false, mode: "legacy" }));
    await queue.claim("worker-1");
    await queue.recordRunIntelligence(run.runId, task(), []);
    expect(inner.recordRunIntelligence).toHaveBeenCalledOnce();
    expect(inner.step).not.toHaveBeenCalled();
  });

  it("contains shadow persistence failure and preserves legacy success", async () => {
    const inner = innerQueue();
    inner.step.mockRejectedValueOnce(new Error("shadow_step_write_failed"));
    const queue = wrapped(inner);
    await queue.claim("worker-1");
    await expect(queue.recordRunIntelligence(run.runId, task(), [])).resolves.toBeUndefined();
    expect(inner.recordRunIntelligence).toHaveBeenCalledOnce();
  });

  it("still propagates required legacy intelligence persistence failures", async () => {
    const inner = innerQueue();
    inner.recordRunIntelligence.mockRejectedValueOnce(new Error("legacy_audit_failed"));
    const queue = wrapped(inner);
    await queue.claim("worker-1");
    await expect(queue.recordRunIntelligence(run.runId, task(), [])).rejects.toThrow("legacy_audit_failed");
    expect(inner.step).not.toHaveBeenCalled();
  });

  it("forwards completion and clears its claimed-run state", async () => {
    const inner = innerQueue();
    const queue = wrapped(inner);
    await queue.claim("worker-1");
    await queue.complete(run, { content: "done", modelVersionId: "model", usage: {} });
    expect(inner.complete).toHaveBeenCalledOnce();
    await queue.recordRunIntelligence(run.runId, task(), []);
    expect(inner.step).not.toHaveBeenCalled();
  });
});
