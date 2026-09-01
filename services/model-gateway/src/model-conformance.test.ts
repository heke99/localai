import { describe, expect, it } from "vitest";
import type { GenerateRequest, GenerateResult, ModelAdapter, ModelCapability, ModelHealth, ModelProtocolProfile } from "@div3rsa/model-sdk";
import { runModelConformance } from "./model-conformance";

const profile: ModelProtocolProfile = {
  contractVersion: 1,
  protocol: "generic-openai",
  runtimeModel: "fixture-model",
  modelVersionId: "fixture-model-v1",
  capabilities: ["general", "tool_use"],
  protocolCapabilities: ["text_generation", "native_tool_calls", "tool_result_continuation"]
};

class ConformantFixtureAdapter implements ModelAdapter {
  getCapabilities(): ReadonlySet<ModelCapability> { return new Set(profile.capabilities); }
  async healthCheck(): Promise<ModelHealth> { return { ok: true, latencyMs: 1 }; }
  async estimateTokens(text: string): Promise<number> { return text.length; }
  async *stream(request: GenerateRequest): AsyncIterable<string> { yield (await this.generate(request)).content; }
  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const toolResult = request.messages.find((message) => message.role === "tool");
    if (toolResult) {
      const parsed = JSON.parse(toolResult.content) as { continuationToken: string };
      return { modelVersionId: profile.modelVersionId, content: parsed.continuationToken, finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 } };
    }
    const currentTime = request.tools?.find((candidate) => candidate.name === "current_time");
    if (currentTime) {
      return {
        modelVersionId: profile.modelVersionId,
        content: "",
        finishReason: "tool_call",
        toolCalls: [{ id: "fixture-call", name: "current_time", input: { timezone: "Europe/Stockholm" } }],
        usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 }
      };
    }
    const textToken = /MODEL_CONFORMANCE_TEXT_[A-Za-z0-9_-]+/.exec(request.messages.at(-1)?.content ?? "")?.[0] ?? "missing";
    return { modelVersionId: profile.modelVersionId, content: textToken, finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 } };
  }
}

class BrokenToolAdapter extends ConformantFixtureAdapter {
  override async generate(request: GenerateRequest): Promise<GenerateResult> {
    if (request.tools?.some((tool) => tool.name === "current_time") && !request.messages.some((message) => message.role === "tool")) {
      return { modelVersionId: profile.modelVersionId, content: "<tool_call>broken</tool_call>", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 } };
    }
    return super.generate(request);
  }
}

describe("model conformance", () => {
  it("accepts an adapter based only on the shared ModelAdapter contract", async () => {
    const report = await runModelConformance(new ConformantFixtureAdapter(), profile, { tokenSeed: "unit" });
    expect(report.allowed).toBe(true);
    expect(report.passed).toBe(report.cases);
    expect(report.failed).toBe(0);
    expect(report.results.find((result) => result.id === "native-tool-call")?.passed).toBe(true);
    expect(report.results.find((result) => result.id === "tool-result-continuation")?.passed).toBe(true);
  });

  it("fails closed when a replacement model cannot produce native tool calls", async () => {
    const report = await runModelConformance(new BrokenToolAdapter(), profile, { tokenSeed: "broken" });
    expect(report.allowed).toBe(false);
    expect(report.results.find((result) => result.id === "native-tool-call")?.passed).toBe(false);
    expect(report.results.find((result) => result.id === "tool-result-continuation")?.passed).toBe(false);
  });
});
