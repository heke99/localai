import { describe, expect, it, vi } from "vitest";
import type { ModelAdapter, ModelToolDefinition } from "@div3rsa/model-sdk";
import { AgentWorkerProcessor, type AgentQueue, type ClaimedRun, type WorkerToolRuntime } from "./processor";

function queue(run: ClaimedRun): AgentQueue & {
  complete: ReturnType<typeof vi.fn>;
  fail: ReturnType<typeof vi.fn>;
  recordVerificationRun: ReturnType<typeof vi.fn>;
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

function baseRun(overrides: Partial<ClaimedRun> = {}): ClaimedRun {
  return {
    jobId: "job",
    runId: "run",
    mode: "chat",
    modelAlias: "general-prod",
    prompt: "Förklara Pythagoras sats enkelt.",
    requestId: "request",
    traceId: "trace",
    resourceContext: [],
    ...overrides
  };
}

function adapter(generate: ModelAdapter["generate"]): ModelAdapter {
  return {
    generate,
    async *stream() { yield ""; },
    estimateTokens: async () => 1,
    getCapabilities: () => new Set(["general", "tool_use"]),
    healthCheck: async () => ({ ok: true, latencyMs: 1 })
  };
}

const currentTools: ModelToolDefinition[] = [
  { name: "current_time", description: "time", inputSchema: { type: "object" } },
  { name: "web_search", description: "search", inputSchema: { type: "object" } },
  { name: "web_fetch", description: "fetch", inputSchema: { type: "object" } }
];

describe("AgentWorkerProcessor execution policy", () => {
  it("completes ordinary chat even when a writable repository is selected", async () => {
    const run = baseRun({
      resourceContext: [{
        resourceId: "repo-1",
        connectionId: "conn-1",
        provider: "github",
        resourceType: "repository",
        externalResourceId: "heke99/localai",
        displayName: "localai",
        capabilities: ["github.contents.read", "github.contents.write"]
      }]
    });
    const jobs = queue(run);
    const model = adapter(vi.fn(async () => ({
      modelVersionId: "model",
      content: "En kort förklaring.",
      finishReason: "stop" as const,
      usage: { inputTokens: 5, outputTokens: 4, cachedTokens: 0 }
    })));
    await new AgentWorkerProcessor(jobs, { resolve: () => model }, "worker").processOnce();
    expect(jobs.complete).toHaveBeenCalledOnce();
    expect(jobs.fail).not.toHaveBeenCalled();
    expect(jobs.recordVerificationRun).toHaveBeenCalledOnce();
  });

  it("completes a live clock request in one verification round when current_time evidence exists", async () => {
    const run = baseRun({ prompt: "Vad är klockan i Stockholm just nu?" });
    const jobs = queue(run);
    const generate = vi.fn()
      .mockResolvedValueOnce({
        modelVersionId: "model",
        content: "",
        finishReason: "tool_call" as const,
        toolCalls: [{ id: "time-1", name: "current_time", input: { timezone: "Europe/Stockholm" } }],
        usage: { inputTokens: 5, outputTokens: 1, cachedTokens: 0 }
      })
      .mockResolvedValueOnce({
        modelVersionId: "model",
        content: "Klockan är 15:30 i Stockholm.",
        finishReason: "stop" as const,
        usage: { inputTokens: 8, outputTokens: 8, cachedTokens: 0 }
      });
    const model = adapter(generate);
    const tools: WorkerToolRuntime = {
      list: vi.fn(async () => currentTools),
      execute: vi.fn(async (_claimed, call) => {
        if (call.name === "current_time") return { timezone: "Europe/Stockholm", localTime: "15:30:00", retrievedAt: "2026-08-27T13:30:00.000Z" };
        throw new Error("unexpected_tool");
      })
    };
    await new AgentWorkerProcessor(jobs, { resolve: () => model }, "worker", undefined, tools).processOnce();
    expect(generate).toHaveBeenCalledTimes(2);
    expect(jobs.recordVerificationRun).toHaveBeenCalledOnce();
    expect(jobs.complete).toHaveBeenCalledOnce();
    expect(jobs.fail).not.toHaveBeenCalled();
  });

  it("completes low-risk current research after search plus one opened source without verification retries", async () => {
    const run = baseRun({ prompt: "Vad är senaste stabila versionen av Node.js just nu?", modelAlias: "research-prod" });
    const jobs = queue(run);
    const generate = vi.fn()
      .mockResolvedValueOnce({
        modelVersionId: "model",
        content: "",
        finishReason: "tool_call" as const,
        toolCalls: [{ id: "search-1", name: "web_search", input: { query: "Node.js latest stable version" } }],
        usage: { inputTokens: 5, outputTokens: 1, cachedTokens: 0 }
      })
      .mockResolvedValueOnce({
        modelVersionId: "model",
        content: "",
        finishReason: "tool_call" as const,
        toolCalls: [{ id: "fetch-1", name: "web_fetch", input: { url: "https://nodejs.org/en/download" } }],
        usage: { inputTokens: 8, outputTokens: 1, cachedTokens: 0 }
      })
      .mockResolvedValueOnce({
        modelVersionId: "model",
        content: "Node.js current stable version is grounded in the opened official page.",
        finishReason: "stop" as const,
        usage: { inputTokens: 12, outputTokens: 10, cachedTokens: 0 }
      });
    const model = adapter(generate);
    const tools: WorkerToolRuntime = {
      list: vi.fn(async () => currentTools),
      execute: vi.fn(async (_claimed, call) => {
        if (call.name === "web_search") return { results: [{ url: "https://nodejs.org/en/download", title: "Download Node.js" }] };
        if (call.name === "web_fetch") return { url: "https://nodejs.org/en/download", retrievedAt: "2026-08-27T13:30:00.000Z", text: "official release information" };
        throw new Error("unexpected_tool");
      })
    };
    await new AgentWorkerProcessor(jobs, { resolve: () => model }, "worker", undefined, tools).processOnce();
    expect(generate).toHaveBeenCalledTimes(3);
    expect(jobs.recordVerificationRun).toHaveBeenCalledOnce();
    expect(jobs.complete).toHaveBeenCalledOnce();
    expect(jobs.fail).not.toHaveBeenCalled();
  });
});
