import { describe, expect, it, vi } from "vitest";
import type { GenerateRequest, ModelAdapter, ModelToolDefinition } from "@div3rsa/model-sdk";
import { AgentWorkerProcessor, type AgentQueue, type ClaimedRun, type WorkerToolRuntime } from "./processor";

function queue(run: ClaimedRun): AgentQueue & {
  complete: ReturnType<typeof vi.fn>;
  fail: ReturnType<typeof vi.fn>;
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

function currentRun(): ClaimedRun {
  return {
    jobId: "job",
    runId: "run",
    mode: "research",
    modelAlias: "research-prod",
    prompt: "What is the current standard Example Tax rate? Check current web information.",
    requestId: "request",
    traceId: "trace",
    resourceContext: []
  };
}

describe("current-information evidence diversity", () => {
  it("opens a second ranked fallback when the first successful fetch does not strengthen the rejected claim", async () => {
    const run = currentRun();
    const jobs = queue(run);
    const requests: GenerateRequest[] = [];
    const generate = vi.fn(async (request: GenerateRequest) => {
      requests.push(request);
      const index = requests.length;
      if (index === 1) {
        return {
          modelVersionId: "model",
          content: "The current standard Example Tax rate is 25%.",
          finishReason: "stop" as const,
          usage: { inputTokens: 20, outputTokens: 8, cachedTokens: 0 }
        };
      }
      if (index === 2) {
        return {
          modelVersionId: "model",
          content: "The current standard Example Tax rate is 25% according to the opened overview.",
          finishReason: "stop" as const,
          usage: { inputTokens: 25, outputTokens: 10, cachedTokens: 0 }
        };
      }
      if (index === 3) {
        return {
          modelVersionId: "model",
          content: "I need stronger evidence.",
          finishReason: "stop" as const,
          usage: { inputTokens: 22, outputTokens: 8, cachedTokens: 0 }
        };
      }
      return {
        modelVersionId: "model",
        content: "The current standard Example Tax rate is 25% according to the competent authority.",
        finishReason: "stop" as const,
        usage: { inputTokens: 30, outputTokens: 12, cachedTokens: 0 }
      };
    });

    let goodSourceOpened = false;
    const verifierGenerate = vi.fn(async () => ({
      modelVersionId: "verifier",
      content: goodSourceOpened
        ? '{"passed":true,"reason":"The opened competent-authority page explicitly states 25%."}'
        : '{"passed":false,"reason":"The opened pages do not explicitly state the current standard rate is 25%."}',
      finishReason: "stop" as const,
      usage: { inputTokens: 10, outputTokens: 8, cachedTokens: 0 }
    }));

    const irrelevantUrl = "https://docs.example.org/tax-background";
    const goodUrl = "https://authority.example.org/current-tax-rates";
    const attemptedFetches: string[] = [];
    const execute = vi.fn(async (_claimed: ClaimedRun, call: { id: string; name: string; input: Record<string, unknown> }) => {
      if (call.name === "web_search") {
        if (call.id.includes("grounding-fallback-search")) {
          return {
            results: [
              { url: irrelevantUrl, title: "Example Tax background", snippet: "General Example Tax guidance", score: 100 },
              { url: goodUrl, title: "Current standard Example Tax rate 25%", snippet: "Standard rate: 25%", score: 90 },
              { url: "https://example.com/tax-overview", title: "Tax overview", snippet: "Tax information", score: 10 }
            ]
          };
        }
        return {
          results: [
            { url: "https://example.com/tax-overview", title: "Tax overview", snippet: "Tax information", score: 10 }
          ]
        };
      }
      if (call.name === "web_fetch") {
        const url = String(call.input.url ?? "");
        attemptedFetches.push(url);
        if (url === goodUrl) {
          goodSourceOpened = true;
          return { url, retrievedAt: "2026-08-27T20:00:00.000Z", text: "Current standard Example Tax rate: 25%." };
        }
        if (url === irrelevantUrl) {
          return { url, retrievedAt: "2026-08-27T20:00:00.000Z", text: "Background information about Example Tax without the current standard rate." };
        }
        return { url, retrievedAt: "2026-08-27T20:00:00.000Z", text: "Example Tax overview without a current standard rate." };
      }
      throw new Error(`unexpected_tool:${call.name}`);
    });

    const tools: WorkerToolRuntime = { list: vi.fn(async () => currentTools), execute: execute as never };
    const resolver = {
      resolve: (alias: string) => alias === "verifier-prod" ? adapter(verifierGenerate) : adapter(generate)
    };

    await new AgentWorkerProcessor(jobs, resolver as never, "worker", undefined, tools).processOnce();

    expect(attemptedFetches).toContain(irrelevantUrl);
    expect(attemptedFetches).toContain(goodUrl);
    expect(attemptedFetches.indexOf(irrelevantUrl)).toBeLessThan(attemptedFetches.indexOf(goodUrl));
    expect(jobs.fail).not.toHaveBeenCalled();
    expect(jobs.complete).toHaveBeenCalledWith(run, expect.objectContaining({ content: expect.stringContaining("25%") }));
  });
});
