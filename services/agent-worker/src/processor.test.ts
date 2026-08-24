import { describe, expect, it, vi } from "vitest";
import type { ModelAdapter } from "@div3rsa/model-sdk";
import { AgentWorkerProcessor, type AgentQueue, type ClaimedRun } from "./processor";

const run: ClaimedRun = { jobId: "job", runId: "run", mode: "code", modelAlias: "code-prod", prompt: "implement feature", requestId: "request", traceId: "trace", resourceContext: [] };
const adapter: ModelAdapter = {
  generate: vi.fn(async () => ({ modelVersionId: "model", content: "done", finishReason: "stop" as const, usage: { inputTokens: 2, outputTokens: 1, cachedTokens: 0 } })),
  async *stream() { yield "done"; }, estimateTokens: async () => 1, getCapabilities: () => new Set(["coding"]), healthCheck: async () => ({ ok: true, latencyMs: 1 })
};

function queue(claimed: ClaimedRun | null = run): AgentQueue & {
  step: ReturnType<typeof vi.fn>;
  recordRunIntelligence: ReturnType<typeof vi.fn>;
  recordRepositoryIndex: ReturnType<typeof vi.fn>;
  recordImpactAnalysis: ReturnType<typeof vi.fn>;
  recordVerificationRun: ReturnType<typeof vi.fn>;
  complete: ReturnType<typeof vi.fn>;
  fail: ReturnType<typeof vi.fn>;
} {
  return {
    claim: vi.fn(async () => claimed),
    step: vi.fn(async () => undefined),
    recordRunIntelligence: vi.fn(async () => undefined),
    recordRepositoryIndex: vi.fn(async () => "00000000-0000-0000-0000-000000000001"),
    recordImpactAnalysis: vi.fn(async () => "00000000-0000-0000-0000-000000000002"),
    recordVerificationRun: vi.fn(async () => "00000000-0000-0000-0000-000000000003"),
    complete: vi.fn(async () => undefined),
    fail: vi.fn(async () => undefined),
    isCancelled: vi.fn(async () => false)
  };
}

describe("AgentWorkerProcessor", () => {
  it("persists intelligence and verification before completing", async () => {
    const jobs = queue();
    await expect(new AgentWorkerProcessor(jobs, { resolve: () => adapter }, "worker-1").processOnce()).resolves.toBe(true);
    expect(jobs.recordRunIntelligence).toHaveBeenCalledOnce();
    expect(jobs.recordVerificationRun).toHaveBeenCalledOnce();
    expect(jobs.complete).toHaveBeenCalledOnce();
    expect(jobs.recordVerificationRun.mock.invocationCallOrder[0]).toBeLessThan(jobs.complete.mock.invocationCallOrder[0]!);
    expect(jobs.step.mock.calls.map((call) => call[1])).toContain("verify");
  });

  it("executes structured tool calls before completing", async () => {
    const jobs = queue({ ...run, resourceContext: [{ resourceId: "repo-1", connectionId: "c-1", provider: "github", resourceType: "repository", externalResourceId: "heke99/localai", displayName: "localai", capabilities: ["github.contents.read"] }] });
    const generate = vi.fn()
      .mockResolvedValueOnce({ modelVersionId: "model", content: "", finishReason: "tool_call", toolCalls: [{ id: "call-1", name: "github_read_file", input: { resourceId: "repo-1", path: "README.md" } }], usage: { inputTokens: 2, outputTokens: 1, cachedTokens: 0 } })
      .mockResolvedValueOnce({ modelVersionId: "model", content: "read complete", finishReason: "stop", usage: { inputTokens: 3, outputTokens: 2, cachedTokens: 0 } });
    const toolRuntime = { list: vi.fn(async () => [{ name: "github_read_file", description: "Read file", inputSchema: { type: "object" } }]), execute: vi.fn(async () => ({ content: "hello" })) };
    await new AgentWorkerProcessor(jobs, { resolve: () => ({ ...adapter, generate }) }, "worker-1", undefined, toolRuntime).processOnce();
    expect(toolRuntime.execute).toHaveBeenCalledOnce();
    expect(generate).toHaveBeenCalledTimes(2);
    expect(jobs.recordVerificationRun).toHaveBeenCalledOnce();
    expect(jobs.complete).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ content: "read complete" }));
  });

  it("fails the run when audit persistence fails instead of completing without evidence", async () => {
    const jobs = queue();
    jobs.recordVerificationRun.mockRejectedValueOnce(new Error("audit_persistence_failed"));
    await new AgentWorkerProcessor(jobs, { resolve: () => adapter }, "worker-1").processOnce();
    expect(jobs.complete).not.toHaveBeenCalled();
    expect(jobs.fail).toHaveBeenCalledWith(run, "audit_persistence_failed", false);
  });

  it("classifies transient model errors as retryable", async () => {
    const jobs = queue();
    const unavailable = { ...adapter, generate: vi.fn(async () => { throw new Error("503 unavailable"); }) };
    await new AgentWorkerProcessor(jobs, { resolve: () => unavailable }, "worker-1").processOnce();
    expect(jobs.fail).toHaveBeenCalledWith(run, "503 unavailable", true);
  });

  it("returns false when the queue is empty", async () => {
    await expect(new AgentWorkerProcessor(queue(null), { resolve: () => adapter }, "worker-1").processOnce()).resolves.toBe(false);
  });
});
