import { describe, expect, it, vi } from "vitest";
import type { AgentQueue, ClaimedRun } from "../processor";
import { VerifiedLearningAgentQueue } from "./learning-lifecycle";
import type { SupabaseAgentKernelStore } from "./store";

const run: ClaimedRun = {
  jobId: "job-1",
  runId: "11111111-1111-4111-8111-111111111111",
  mode: "code",
  modelAlias: "code-prod",
  prompt: "secret prompt must not be stored",
  requestId: "req-1",
  traceId: "trace-1",
  resourceContext: [{ resourceId: "repo-1", connectionId: "conn-1", provider: "github", resourceType: "repository", externalResourceId: "1", displayName: "Heke99/LocalAI", capabilities: ["github.contents.read"] }]
};

function baseQueue() {
  return {
    claim: vi.fn(async () => null), step: vi.fn(async () => undefined), stream: vi.fn(async () => undefined),
    recordRunIntelligence: vi.fn(async () => undefined), recordRepositoryIndex: vi.fn(async () => "idx"), recordImpactAnalysis: vi.fn(async () => "impact"), recordVerificationRun: vi.fn(async () => "verification"),
    complete: vi.fn(async () => undefined), fail: vi.fn(async () => undefined), isCancelled: vi.fn(async () => false)
  } as unknown as AgentQueue;
}

function store() {
  return {
    upsertMemory: vi.fn(async () => undefined),
    recordTrajectory: vi.fn(async () => undefined),
    findMemories: vi.fn(async () => []),
    recordCheckpoint: vi.fn(async () => undefined),
    latestVerifiedCheckpoint: vi.fn(async () => null)
  } as unknown as SupabaseAgentKernelStore;
}

const task = {
  categories: ["bugfix"], risk: "medium", reasoningLevel: "standard", verificationRequirements: ["tests"], requiresCurrentInformation: false,
  requiresLiveData: false, liveDataKind: "none", researchDepth: "none", informationFreshness: "stable", requiresRepository: true, requiresDatabase: false, requiresDeployment: false, requiresBrowser: false, requiresSecurityReview: false,
  project: { languages: ["typescript"], frameworks: [], database: [], services: [], hosting: [] }
} as never;

const report = {
  plan: { checks: [{ kind: "unit-tests", required: true, reason: "test" }, { kind: "completion-proof", required: true, reason: "proof" }] },
  results: [
    { kind: "unit-tests", status: "passed", summary: "green", evidence: ["ci:123"], durationMs: 10 },
    { kind: "completion-proof", status: "passed", summary: "all green" }
  ],
  passed: true,
  unresolvedBlockers: []
} as never;

describe("VerifiedLearningAgentQueue", () => {
  it("persists only structural verified learning after successful completion", async () => {
    const base = baseQueue();
    const kernelStore = store();
    const queue = new VerifiedLearningAgentQueue(base, kernelStore, true, false, { warn: vi.fn() });

    await queue.recordRunIntelligence(run.runId, task, ["debugger", "testing"]);
    await queue.recordVerificationRun(run.runId, 0, null, null, report.plan, report, { passed: true, reason: "green" });
    await queue.complete(run, { content: "final answer containing secret", modelVersionId: "qwen-v3-q8", usage: { inputTokens: 100, outputTokens: 20, cachedTokens: 10 } });

    expect(kernelStore.upsertMemory).toHaveBeenCalledTimes(2);
    const serialized = JSON.stringify((kernelStore.upsertMemory as ReturnType<typeof vi.fn>).mock.calls);
    expect(serialized).toContain("repo:heke99/localai");
    expect(serialized).toContain("categories=bugfix");
    expect(serialized).not.toContain("secret prompt");
    expect(serialized).not.toContain("final answer containing secret");
    expect(kernelStore.recordTrajectory).toHaveBeenCalledTimes(1);
    expect((kernelStore.recordTrajectory as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toBe(false);
  });

  it("does not learn from failed verification", async () => {
    const kernelStore = store();
    const queue = new VerifiedLearningAgentQueue(baseQueue(), kernelStore, true, true, { warn: vi.fn() });
    await queue.recordRunIntelligence(run.runId, task, ["debugger"]);
    await queue.recordVerificationRun(run.runId, 0, null, null, report.plan, { ...report, passed: false, unresolvedBlockers: ["unit-tests:failed"] } as never, { passed: false, reason: "red" });
    await queue.complete(run, { content: "bad", modelVersionId: "qwen", usage: {} });
    expect(kernelStore.upsertMemory).not.toHaveBeenCalled();
    expect(kernelStore.recordTrajectory).not.toHaveBeenCalled();
  });
});
