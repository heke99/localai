import { describe, expect, it, vi } from "vitest";
import type { GenerateRequest, ModelAdapter, ModelToolDefinition } from "@div3rsa/model-sdk";
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

  it("finalizes a live clock request deterministically from current_time without a model turn", async () => {
    const run = baseRun({ prompt: "Vad är klockan i Stockholm just nu?" });
    const jobs = queue(run);
    const generate = vi.fn(async () => ({
      modelVersionId: "model",
      content: "fel modellvärde",
      finishReason: "stop" as const,
      usage: { inputTokens: 8, outputTokens: 8, cachedTokens: 0 }
    }));
    const execute = vi.fn(async (_claimed, call) => {
      if (call.name === "current_time") return { timezone: "Europe/Stockholm", localTime: "15:30:00", retrievedAt: "2026-08-27T13:30:00.000Z" };
      throw new Error("unexpected_tool");
    });
    const tools: WorkerToolRuntime = { list: vi.fn(async () => currentTools), execute };
    await new AgentWorkerProcessor(jobs, { resolve: () => adapter(generate) }, "worker", undefined, tools).processOnce();
    expect(generate).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[1].name).toBe("current_time");
    expect(execute.mock.calls[0]?.[1].input).toEqual({ timezone: "Europe/Stockholm" });
    expect(jobs.complete).toHaveBeenCalledWith(run, expect.objectContaining({ content: "The current time in Europe/Stockholm is 15:30:00." }));
    expect(jobs.recordVerificationRun).toHaveBeenCalledOnce();
    expect(jobs.fail).not.toHaveBeenCalled();
  });

  it("returns an exact requested live date from current_time instead of model memory", async () => {
    const run = baseRun({ prompt: "What is today's date in Europe/Stockholm right now? Use the live time capability rather than model memory. Return the date in YYYY-MM-DD format." });
    const jobs = queue(run);
    const generate = vi.fn(async () => ({
      modelVersionId: "model",
      content: "2026-06-25",
      finishReason: "stop" as const,
      usage: { inputTokens: 8, outputTokens: 8, cachedTokens: 0 }
    }));
    const execute = vi.fn(async (_claimed, call) => {
      if (call.name === "current_time") return {
        timezone: "Europe/Stockholm",
        localDate: "2026-08-27",
        localTime: "19:10:00",
        localIso: "2026-08-27T19:10:00+02:00",
        retrievedAt: "2026-08-27T17:10:00.000Z"
      };
      throw new Error("unexpected_tool");
    });
    const tools: WorkerToolRuntime = { list: vi.fn(async () => currentTools), execute };
    await new AgentWorkerProcessor(jobs, { resolve: () => adapter(generate) }, "worker", undefined, tools).processOnce();
    expect(generate).not.toHaveBeenCalled();
    expect(jobs.complete).toHaveBeenCalledWith(run, expect.objectContaining({ content: "2026-08-27" }));
    expect(jobs.fail).not.toHaveBeenCalled();
  });

  it("collects current web evidence, synthesizes tool-free, then independently reviews the answer", async () => {
    const run = baseRun({ prompt: "Vad är senaste stabila versionen av Node.js just nu?", modelAlias: "research-prod" });
    const jobs = queue(run);
    const requests: GenerateRequest[] = [];
    const generate = vi.fn(async (request: GenerateRequest) => {
      requests.push(request);
      if (requests.length === 1) {
        return {
          modelVersionId: "model",
          content: "Let me open the official Node.js release page next.",
          finishReason: "stop" as const,
          usage: { inputTokens: 12, outputTokens: 10, cachedTokens: 0 }
        };
      }
      return {
        modelVersionId: "model",
        content: "The verified current Node.js release is v24.7.0 according to https://nodejs.org/en/download.",
        finishReason: "stop" as const,
        usage: { inputTokens: 20, outputTokens: 14, cachedTokens: 0 }
      };
    });
    const verifierGenerate = vi.fn(async () => ({
      modelVersionId: "verifier",
      content: '{"passed":true,"reason":"The answer matches the opened current release evidence."}',
      finishReason: "stop" as const,
      usage: { inputTokens: 10, outputTokens: 8, cachedTokens: 0 }
    }));
    const execute = vi.fn(async (_claimed, call) => {
      if (call.name === "web_search") return { results: [{ url: "https://nodejs.org/en/download", title: "Download Node.js", score: 10 }] };
      if (call.name === "web_fetch") return { url: "https://nodejs.org/en/download", retrievedAt: "2026-08-27T13:30:00.000Z", text: "Latest release v24.7.0" };
      throw new Error("unexpected_tool");
    });
    const tools: WorkerToolRuntime = { list: vi.fn(async () => currentTools), execute };
    const resolver = {
      resolve: (alias: string) => alias === "verifier-prod" ? adapter(verifierGenerate) : adapter(generate)
    };
    await new AgentWorkerProcessor(jobs, resolver as never, "worker", undefined, tools).processOnce();
    expect(generate).toHaveBeenCalledTimes(2);
    expect(verifierGenerate).toHaveBeenCalledOnce();
    expect(requests[0]?.tools?.map((tool) => tool.name)).toEqual(["current_time", "web_search", "web_fetch"]);
    expect(requests[1]?.tools).toEqual([]);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls.map((call) => call[1].name)).toEqual(["web_search", "web_fetch"]);
    expect(jobs.complete).toHaveBeenCalledWith(run, expect.objectContaining({ content: expect.stringContaining("v24.7.0") }));
    expect(jobs.recordVerificationRun).toHaveBeenCalledOnce();
    expect(jobs.fail).not.toHaveBeenCalled();
  });
});
