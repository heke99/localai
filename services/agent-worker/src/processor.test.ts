import { describe, expect, it, vi } from "vitest";
import type { ModelAdapter } from "@div3rsa/model-sdk";
import { AgentWorkerProcessor, type AgentQueue, type ClaimedRun } from "./processor";

const run: ClaimedRun = { jobId: "job", runId: "run", mode: "code", modelAlias: "code-prod", prompt: "implement feature", requestId: "request", traceId: "trace" };
const adapter: ModelAdapter = {
  generate: vi.fn(async () => ({ modelVersionId: "model", content: "done", finishReason: "stop" as const, usage: { inputTokens: 2, outputTokens: 1, cachedTokens: 0 } })),
  async *stream() { yield "done"; }, estimateTokens: async () => 1, getCapabilities: () => new Set(["coding"]), healthCheck: async () => ({ ok: true, latencyMs: 1 })
};

function queue(claimed: ClaimedRun | null = run): AgentQueue & { step: ReturnType<typeof vi.fn>; complete: ReturnType<typeof vi.fn>; fail: ReturnType<typeof vi.fn> } {
  return { claim: vi.fn(async () => claimed), step: vi.fn(async () => undefined), complete: vi.fn(async () => undefined), fail: vi.fn(async () => undefined), isCancelled: vi.fn(async () => false) };
}

describe("AgentWorkerProcessor", () => {
  it("claims, activates skills, verifies and completes", async () => {
    const jobs = queue();
    await expect(new AgentWorkerProcessor(jobs, { resolve: () => adapter }, "worker-1").processOnce()).resolves.toBe(true);
    expect(jobs.complete).toHaveBeenCalledOnce();
    expect(jobs.step.mock.calls.map((call) => call[1])).toContain("verify");
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
