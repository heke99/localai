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

describe("current-information evidence repair", () => {
  it("gathers new opened evidence after reviewer rejection instead of only rewriting the answer", async () => {
    const run: ClaimedRun = {
      jobId: "job",
      runId: "run",
      mode: "research",
      modelAlias: "research-prod",
      prompt: "Vad är den aktuella vanliga momssatsen i Sverige just nu? Kontrollera aktuell information på webben.",
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
          content: "The current standard VAT rate is 25%.",
          finishReason: "stop" as const,
          usage: { inputTokens: 20, outputTokens: 8, cachedTokens: 0 }
        };
      }
      if (index === 2) {
        return {
          modelVersionId: "model",
          content: "The current standard VAT rate in Sweden is 25%.",
          finishReason: "stop" as const,
          usage: { inputTokens: 30, outputTokens: 10, cachedTokens: 0 }
        };
      }
      if (index === 3) {
        return {
          modelVersionId: "model",
          content: "",
          finishReason: "tool_call" as const,
          toolCalls: [{ id: "repair-search", name: "web_search", input: { query: "Skatteverket momssatser 25 procent", limit: 12 } }],
          usage: { inputTokens: 25, outputTokens: 5, cachedTokens: 0 }
        };
      }
      if (index === 4) {
        return {
          modelVersionId: "model",
          content: "",
          finishReason: "tool_call" as const,
          toolCalls: [{ id: "repair-fetch", name: "web_fetch", input: { url: "https://www.skatteverket.se/foretag/moms/momssatser.html" } }],
          usage: { inputTokens: 25, outputTokens: 5, cachedTokens: 0 }
        };
      }
      return {
        modelVersionId: "model",
        content: "Den aktuella vanliga momssatsen i Sverige är 25 procent, enligt Skatteverket.",
        finishReason: "stop" as const,
        usage: { inputTokens: 35, outputTokens: 14, cachedTokens: 0 }
      };
    });

    let reviewCount = 0;
    const verifierGenerate = vi.fn(async () => {
      reviewCount += 1;
      return {
        modelVersionId: "verifier",
        content: reviewCount === 1
          ? '{"passed":false,"reason":"The opened evidence does not explicitly state the standard VAT rate."}'
          : '{"passed":true,"reason":"The newly opened Skatteverket evidence explicitly states 25 procent."}',
        finishReason: "stop" as const,
        usage: { inputTokens: 10, outputTokens: 8, cachedTokens: 0 }
      };
    });

    let searchCount = 0;
    const execute = vi.fn(async (_claimed: ClaimedRun, call: { name: string; input: Record<string, unknown> }) => {
      if (call.name === "web_search") {
        searchCount += 1;
        if (searchCount === 1) {
          return { results: [{ url: "https://example.com/sweden-vat", title: "Sweden VAT overview", snippet: "VAT information", score: 10 }] };
        }
        return { results: [{ url: "https://www.skatteverket.se/foretag/moms/momssatser.html", title: "Momssatser", snippet: "25 procent", score: 100 }] };
      }
      if (call.name === "web_fetch") {
        const url = String(call.input.url ?? "");
        if (url.includes("skatteverket.se")) {
          return { url, retrievedAt: "2026-08-27T20:00:00.000Z", text: "Den generella momssatsen är 25 procent." };
        }
        return { url, retrievedAt: "2026-08-27T20:00:00.000Z", text: "Sweden applies VAT to many goods and services." };
      }
      throw new Error(`unexpected_tool:${call.name}`);
    });
    const tools: WorkerToolRuntime = { list: vi.fn(async () => currentTools), execute: execute as never };
    const resolver = {
      resolve: (alias: string) => alias === "verifier-prod" ? adapter(verifierGenerate) : adapter(generate)
    };

    await new AgentWorkerProcessor(jobs, resolver as never, "worker", undefined, tools).processOnce();

    expect(searchCount).toBeGreaterThanOrEqual(2);
    expect(execute.mock.calls.some(([, call]) => call.name === "web_fetch" && String(call.input.url).includes("skatteverket.se"))).toBe(true);
    expect(requests.some((request) => request.tools?.some((tool) => tool.name === "web_search") && request.messages.some((message) => String(message.content ?? "").includes("opened evidence does not explicitly")))).toBe(true);
    expect(verifierGenerate).toHaveBeenCalledTimes(2);
    expect(jobs.complete).toHaveBeenCalledWith(run, expect.objectContaining({ content: expect.stringContaining("25 procent") }));
    expect(jobs.fail).not.toHaveBeenCalled();
  });
});
