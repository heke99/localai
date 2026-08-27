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

describe("current-information deterministic evidence fallback", () => {
  it("searches and opens a new ranked source when the repair model stops without a tool call", async () => {
    const run: ClaimedRun = {
      jobId: "job",
      runId: "run",
      mode: "research",
      modelAlias: "research-prod",
      prompt: "What is the current release of Example Runtime? Check current web information.",
      requestId: "request",
      traceId: "trace",
      resourceContext: []
    };
    const jobs = queue(run);
    const requests: GenerateRequest[] = [];
    const generate = vi.fn(async (request: GenerateRequest) => {
      requests.push(request);
      const index = requests.length;
      if (index === 1) {
        return {
          modelVersionId: "model",
          content: "The current release is v1.0.0.",
          finishReason: "stop" as const,
          usage: { inputTokens: 20, outputTokens: 8, cachedTokens: 0 }
        };
      }
      if (index === 2) {
        return {
          modelVersionId: "model",
          content: "The current release is v1.0.0 according to the opened overview.",
          finishReason: "stop" as const,
          usage: { inputTokens: 25, outputTokens: 10, cachedTokens: 0 }
        };
      }
      if (index === 3) {
        return {
          modelVersionId: "model",
          content: "I cannot improve this without more evidence.",
          finishReason: "stop" as const,
          usage: { inputTokens: 22, outputTokens: 8, cachedTokens: 0 }
        };
      }
      return {
        modelVersionId: "model",
        content: "The current release is v2.0.0 according to the newly opened official Current page.",
        finishReason: "stop" as const,
        usage: { inputTokens: 30, outputTokens: 12, cachedTokens: 0 }
      };
    });

    let reviewCount = 0;
    const verifierGenerate = vi.fn(async () => {
      reviewCount += 1;
      return {
        modelVersionId: "verifier",
        content: reviewCount === 1
          ? '{"passed":false,"reason":"The opened overview does not explicitly identify the current release."}'
          : '{"passed":true,"reason":"The newly opened canonical Current page explicitly identifies v2.0.0."}',
        finishReason: "stop" as const,
        usage: { inputTokens: 10, outputTokens: 8, cachedTokens: 0 }
      };
    });

    let searchCount = 0;
    const execute = vi.fn(async (_claimed: ClaimedRun, call: { id: string; name: string; input: Record<string, unknown> }) => {
      if (call.name === "web_search") {
        searchCount += 1;
        if (call.id.includes("grounding-fallback-search")) {
          return {
            results: [
              { url: "https://docs.example.org/current", title: "Current release v2.0.0", snippet: "Current release v2.0.0", score: 100 },
              { url: "https://example.com/runtime-overview", title: "Runtime overview", snippet: "Release information", score: 10 }
            ]
          };
        }
        return {
          results: [
            { url: "https://example.com/runtime-overview", title: "Runtime overview", snippet: "Release information", score: 10 }
          ]
        };
      }
      if (call.name === "web_fetch") {
        const url = String(call.input.url ?? "");
        if (url === "https://docs.example.org/current") {
          return { url, retrievedAt: "2026-08-27T20:00:00.000Z", text: "Current release v2.0.0" };
        }
        return { url, retrievedAt: "2026-08-27T20:00:00.000Z", text: "Runtime release overview without a current version value." };
      }
      throw new Error(`unexpected_tool:${call.name}`);
    });

    const tools: WorkerToolRuntime = { list: vi.fn(async () => currentTools), execute: execute as never };
    const resolver = {
      resolve: (alias: string) => alias === "verifier-prod" ? adapter(verifierGenerate) : adapter(generate)
    };

    await new AgentWorkerProcessor(jobs, resolver as never, "worker", undefined, tools).processOnce();

    expect(searchCount).toBeGreaterThanOrEqual(2);
    expect(execute.mock.calls.some(([, call]) => call.name === "web_fetch" && call.input.url === "https://docs.example.org/current")).toBe(true);
    expect(requests[2]?.tools?.map((tool) => tool.name)).toEqual(["web_search", "web_fetch"]);
    expect(jobs.fail).not.toHaveBeenCalled();
    expect(verifierGenerate).toHaveBeenCalledTimes(2);
    expect(jobs.complete).toHaveBeenCalledWith(run, expect.objectContaining({ content: expect.stringContaining("v2.0.0") }));
  });
});