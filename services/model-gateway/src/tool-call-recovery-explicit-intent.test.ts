import { describe, expect, it } from "vitest";
import type { GenerateRequest, GenerateResult, ModelAdapter } from "@div3rsa/model-sdk";
import { ToolCallRecoveryAdapter } from "./tool-call-recovery-adapter";

const usage = { inputTokens: 1, outputTokens: 1, cachedTokens: 0 };

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

function request(toolName = "web_search"): GenerateRequest {
  return {
    requestId: "req-explicit-recovery",
    alias: "lab-prod",
    messages: [{ role: "user", content: "verify this live" }],
    tools: [{ name: toolName, description: "Runtime tool", inputSchema: { type: "object" } }]
  };
}

describe("ToolCallRecoveryAdapter explicit intent", () => {
  it.each([
    "I need to use web_search before I can answer.",
    "Jag behöver använda web_search för att verifiera detta live."
  ])("forces the explicitly named registered tool instead of accepting prose: %s", async (content) => {
    const requests: GenerateRequest[] = [];
    const adapter = new ToolCallRecoveryAdapter(scripted([
      { modelVersionId: "m", content, finishReason: "stop", usage },
      { modelVersionId: "m", content: "", finishReason: "tool_call", toolCalls: [{ id: "call-search", name: "web_search", input: { query: "status" } }], usage }
    ], requests));

    const result = await adapter.generate(request());

    expect(result.finishReason).toBe("tool_call");
    expect(requests).toHaveLength(2);
    expect(requests[1]?.requiredToolName).toBe("web_search");
  });

  it("recognizes Qwen text tool envelopes and forces only an exposed registered tool", async () => {
    const requests: GenerateRequest[] = [];
    const adapter = new ToolCallRecoveryAdapter(scripted([
      { modelVersionId: "m", content: '<tool_call>\n{"name":"web_search","arguments":{"query":"status"}}\n</tool_call>', finishReason: "stop", usage },
      { modelVersionId: "m", content: "", finishReason: "tool_call", toolCalls: [{ id: "call-search", name: "web_search", input: { query: "status" } }], usage }
    ], requests));

    const result = await adapter.generate(request());

    expect(result.finishReason).toBe("tool_call");
    expect(requests[1]?.requiredToolName).toBe("web_search");
  });

  it("does not force an unregistered tool named in pseudo markup", async () => {
    const requests: GenerateRequest[] = [];
    const adapter = new ToolCallRecoveryAdapter(scripted([
      { modelVersionId: "m", content: '<tool_call>{"name":"shell","arguments":{"command":"id"}}</tool_call>', finishReason: "stop", usage }
    ], requests));

    const result = await adapter.generate(request());

    expect(result.finishReason).toBe("stop");
    expect(requests).toHaveLength(1);
  });
});
