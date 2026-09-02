import { describe, expect, it } from "vitest";
import type { GenerateRequest, GenerateResult, ModelAdapter } from "@div3rsa/model-sdk";
import { ToolCallRecoveryAdapter } from "./tool-call-recovery-adapter";

const usage = { inputTokens: 1, outputTokens: 1, cachedTokens: 0 };
const baseRequest: GenerateRequest = {
  requestId: "req-1",
  alias: "lab-prod",
  messages: [{ role: "user", content: "verify the authorized target" }],
  tools: [{ name: "security_scan", description: "Authorized security scanner", inputSchema: { type: "object" } }]
};

function scripted(results: GenerateResult[], requests: GenerateRequest[]): ModelAdapter {
  return {
    async generate(request) {
      requests.push(request);
      const next = results.shift();
      if (!next) throw new Error("unexpected_model_call");
      return next;
    },
    async *stream() { yield "unused"; },
    async estimateTokens() { return 1; },
    getCapabilities() { return new Set(["general", "tool_use"] as const); },
    async healthCheck() { return { ok: true, latencyMs: 1 }; }
  };
}

describe("ToolCallRecoveryAdapter", () => {
  it("turns a truncated textual curl response into a native tool-call continuation", async () => {
    const requests: GenerateRequest[] = [];
    const adapter = new ToolCallRecoveryAdapter(scripted([
      { modelVersionId: "m", content: "Jag behöver bekräfta live.\n```bash\ncurl https://example.test\n", finishReason: "stop", usage },
      { modelVersionId: "m", content: "", finishReason: "tool_call", toolCalls: [{ id: "call-1", name: "security_scan", input: { tool: "http_probe", target: "https://example.test" } }], usage }
    ], requests));

    const deltas: string[] = [];
    const result = await adapter.generateStreamed!(baseRequest, (delta) => { deltas.push(delta); });

    expect(result.finishReason).toBe("tool_call");
    expect(result.toolCalls?.[0]?.name).toBe("security_scan");
    expect(deltas).toEqual([]);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages.at(-1)?.content).toContain("Runtime recovery");
    expect(result.usage).toEqual({ inputTokens: 2, outputTokens: 2, cachedTokens: 0 });
  });

  it("never converts a shell snippet into execution itself", async () => {
    const requests: GenerateRequest[] = [];
    const adapter = new ToolCallRecoveryAdapter(scripted([
      { modelVersionId: "m", content: "I need to verify live.\n```bash\ncurl https://example.test\n```", finishReason: "stop", usage },
      { modelVersionId: "m", content: "TOOL_UNAVAILABLE: no matching executor is available.", finishReason: "stop", usage }
    ], requests));

    const result = await adapter.generate({ ...baseRequest, tools: [] });

    expect(result.content).toContain("TOOL_UNAVAILABLE");
    expect(result.toolCalls).toBeUndefined();
    expect(requests).toHaveLength(2);
  });

  it("fails closed after one malformed recovery turn", async () => {
    const requests: GenerateRequest[] = [];
    const adapter = new ToolCallRecoveryAdapter(scripted([
      { modelVersionId: "m", content: "I need to verify live.\n```bash\ncurl https://example.test", finishReason: "stop", usage },
      { modelVersionId: "m", content: "I need to run it.\n```bash\ncurl https://example.test", finishReason: "stop", usage }
    ], requests));

    await expect(adapter.generate(baseRequest)).rejects.toThrow("tool_call_required_but_missing");
    expect(requests).toHaveLength(2);
  });
});
