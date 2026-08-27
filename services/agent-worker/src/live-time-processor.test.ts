import { describe, expect, it, vi } from "vitest";
import type { ModelAdapter, ModelToolDefinition } from "@div3rsa/model-sdk";
import { AgentWorkerProcessor, type AgentQueue, type ClaimedRun, type WorkerToolRuntime } from "./processor";

function queue(run: ClaimedRun): AgentQueue & {
  complete: ReturnType<typeof vi.fn>;
  fail: ReturnType<typeof vi.fn>;
  stream: ReturnType<typeof vi.fn>;
} {
  return {
    claim: vi.fn().mockResolvedValueOnce(run).mockResolvedValue(null),
    step: vi.fn(async () => undefined),
    stream: vi.fn(async () => undefined),
    recordRunIntelligence: vi.fn(async () => undefined),
    recordRepositoryIndex: vi.fn(async () => "repo-index"),
    recordImpactAnalysis: vi.fn(async () => "impact"),
    recordVerificationRun: vi.fn(async () => "verification"),
    complete: vi.fn(async () => undefined),
    fail: vi.fn(async () => undefined),
    isCancelled: vi.fn(async () => false)
  };
}

const currentTimeTool: ModelToolDefinition = {
  name: "current_time",
  description: "Return current time in an IANA timezone",
  inputSchema: { type: "object", properties: { timezone: { type: "string" } }, required: ["timezone"] }
};

describe("exact Stockholm time worker flow", () => {
  it("streams and completes the live answer without invoking Qwen", async () => {
    const run: ClaimedRun = {
      jobId: "job",
      runId: "run",
      mode: "chat",
      modelAlias: "general-prod",
      prompt: "Vilken tid är det i Stockholm?",
      requestId: "request",
      traceId: "trace",
      resourceContext: []
    };
    const jobs = queue(run);
    const generate = vi.fn(async () => {
      throw new Error("model_should_not_be_called_for_deterministic_time");
    });
    const adapter: ModelAdapter = {
      generate,
      async *stream() { yield ""; },
      estimateTokens: async () => 1,
      getCapabilities: () => new Set(["general", "tool_use"]),
      healthCheck: async () => ({ ok: true, latencyMs: 1 })
    };
    const execute = vi.fn(async (_claimed: ClaimedRun, call: { name: string; input: Record<string, unknown> }) => {
      expect(call.name).toBe("current_time");
      expect(call.input).toEqual({ timezone: "Europe/Stockholm" });
      return {
        timezone: "Europe/Stockholm",
        utcNow: "2026-08-27T22:09:00.000Z",
        localIso: "2026-08-28T00:09:00+02:00",
        localDate: "2026-08-28",
        localTime: "00:09:00",
        utcOffsetMinutes: 120
      };
    });
    const tools: WorkerToolRuntime = {
      list: vi.fn(async () => [currentTimeTool]),
      execute: execute as never
    };

    await expect(new AgentWorkerProcessor(jobs, { resolve: () => adapter }, "worker", undefined, tools).processOnce()).resolves.toBe(true);

    expect(generate).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledOnce();
    expect(jobs.fail).not.toHaveBeenCalled();
    expect(jobs.stream).toHaveBeenCalledWith(run.runId, "The current time in Europe/Stockholm is 00:09:00.", true);
    expect(jobs.complete).toHaveBeenCalledWith(run, expect.objectContaining({
      content: "The current time in Europe/Stockholm is 00:09:00.",
      modelVersionId: "deterministic-current-time-v1"
    }));
  });
});
