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

  it("does not use current tools for a stable internal capacity policy", async () => {
    const run = baseRun({
      prompt: "A service has 8 workers. Each worker can safely process 3 simultaneous requests, but production policy reserves 25% of total capacity for recovery traffic. What is the maximum normal concurrent request count?"
    });
    const jobs = queue(run);
    const generate = vi.fn(async () => ({
      modelVersionId: "model",
      content: "18 normal concurrent requests.",
      finishReason: "stop" as const,
      usage: { inputTokens: 12, outputTokens: 6, cachedTokens: 0 }
    }));
    const execute = vi.fn(async () => { throw new Error("stable_prompt_should_not_use_current_tools"); });
    const tools: WorkerToolRuntime = { list: vi.fn(async () => currentTools), execute };
    await new AgentWorkerProcessor(jobs, { resolve: () => adapter(generate) }, "worker", undefined, tools).processOnce();
    expect(generate).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
    expect(jobs.complete).toHaveBeenCalledOnce();
    expect(jobs.fail).not.toHaveBeenCalled();
  });

  it("collects current_time evidence before the first model turn for a live clock request", async () => {
    const run = baseRun({ prompt: "Vad är klockan i Stockholm just nu?" });
    const jobs = queue(run);
    const generate = vi.fn(async () => ({
      modelVersionId: "model",
      content: "Klockan är 15:30 i Stockholm.",
      finishReason: "stop" as const,
      usage: { inputTokens: 8, outputTokens: 8, cachedTokens: 0 }
    }));
    const execute = vi.fn(async (_claimed, call) => {
      if (call.name === "current_time") return { timezone: "Europe/Stockholm", localTime: "15:30:00", retrievedAt: "2026-08-27T13:30:00.000Z" };
      throw new Error("unexpected_tool");
    });
    const tools: WorkerToolRuntime = { list: vi.fn(async () => currentTools), execute };
    await new AgentWorkerProcessor(jobs, { resolve: () => adapter(generate) }, "worker", undefined, tools).processOnce();
    expect(generate).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[1].name).toBe("current_time");
    expect(execute.mock.calls[0]?.[1].input).toEqual({ timezone: "Europe/Stockholm" });
    expect(jobs.recordVerificationRun).toHaveBeenCalledOnce();
    expect(jobs.complete).toHaveBeenCalledOnce();
    expect(jobs.fail).not.toHaveBeenCalled();
  });

  it("collects search plus opened source evidence before the first model turn for current research", async () => {
    const run = baseRun({ prompt: "Vad är senaste stabila versionen av Node.js just nu?", modelAlias: "research-prod" });
    const jobs = queue(run);
    const generate = vi.fn(async () => ({
      modelVersionId: "model",
      content: "Node.js current stable version is grounded in the opened official page.",
      finishReason: "stop" as const,
      usage: { inputTokens: 12, outputTokens: 10, cachedTokens: 0 }
    }));
    const execute = vi.fn(async (_claimed, call) => {
      if (call.name === "web_search") return { results: [{ url: "https://nodejs.org/en/download", title: "Download Node.js", score: 10 }] };
      if (call.name === "web_fetch") return { url: "https://nodejs.org/en/download", retrievedAt: "2026-08-27T13:30:00.000Z", text: "official release information" };
      throw new Error("unexpected_tool");
    });
    const tools: WorkerToolRuntime = { list: vi.fn(async () => currentTools), execute };
    await new AgentWorkerProcessor(jobs, { resolve: () => adapter(generate) }, "worker", undefined, tools).processOnce();
    expect(generate).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls.map((call) => call[1].name)).toEqual(["web_search", "web_fetch"]);
    expect(jobs.recordVerificationRun).toHaveBeenCalledOnce();
    expect(jobs.complete).toHaveBeenCalledOnce();
    expect(jobs.fail).not.toHaveBeenCalled();
  });
});