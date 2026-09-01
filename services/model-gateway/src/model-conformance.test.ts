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
    const requiredTool = request.requiredToolName?.trim();
    if (requiredTool) {
      if (!request.tools?.some((tool) => tool.name === requiredTool)) throw new Error(`required_tool_definition_missing:${requiredTool}`);
      if (requiredTool === "current_time") {
        return {
          modelVersionId: profile.modelVersionId,
          content: "",
          finishReason: "tool_call",
          toolCalls: [{ id: "fixture-time-call", name: "current_time", input: { timezone: "Europe/Stockholm" } }],
          usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 }
        };
      }
      if (requiredTool === "probe_nonce_source") {
        return {
          modelVersionId: profile.modelVersionId,
          content: "",
          finishReason: "tool_call",
          toolCalls: [{ id: "fixture-nonce-source-call", name: "probe_nonce_source", input: { probe: "copy-once" } }],
          usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 }
        };
      }
      if (requiredTool === "submit_probe_nonce") {
        const toolResult = [...request.messages].reverse().find((message) => message.role === "tool");
        if (!toolResult) throw new Error("fixture_tool_result_missing");
        const parsed = JSON.parse(toolResult.content) as { nonce: string };
        return {
          modelVersionId: profile.modelVersionId,
          content: "",
          finishReason: "tool_call",
          toolCalls: [{ id: "fixture-nonce-submit-call", name: "submit_probe_nonce", input: { nonce: parsed.nonce } }],
          usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 }
        };
      }
    }
    const textToken = /MODEL_CONFORMANCE_TEXT_[A-Za-z0-9_-]+/.exec(request.messages.at(-1)?.content ?? "")?.[0] ?? "missing";
    return { modelVersionId: profile.modelVersionId, content: textToken, finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 } };
  }
}

class BrokenToolAdapter extends ConformantFixtureAdapter {
  override async generate(request: GenerateRequest): Promise<GenerateResult> {
    if (request.requiredToolName === "current_time" || request.requiredToolName === "probe_nonce_source") {
      return { modelVersionId: profile.modelVersionId, content: "<tool_call>broken</tool_call>", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 } };
    }
    return super.generate(request);
  }
}

class UngroundedContinuationAdapter extends ConformantFixtureAdapter {
  override async generate(request: GenerateRequest): Promise<GenerateResult> {
    if (request.requiredToolName === "submit_probe_nonce") {
      return {
        modelVersionId: profile.modelVersionId,
        content: "",
        finishReason: "tool_call",
        toolCalls: [{ id: "fixture-bad-nonce-call", name: "submit_probe_nonce", input: { nonce: "INVENTED_NONCE" } }],
        usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 }
      };
    }
    return super.generate(request);
  }
}

class ClockBiasedContinuationAdapter extends ConformantFixtureAdapter {
  override async generate(request: GenerateRequest): Promise<GenerateResult> {
    const clockContaminated = request.messages.some((message) =>
      message.role === "tool" && message.name === "current_time"
      || message.role === "assistant" && message.toolCalls?.some((call) => call.name === "current_time")
    );
    if (request.requiredToolName === "submit_probe_nonce" && clockContaminated) {
      return {
        modelVersionId: profile.modelVersionId,
        content: "",
        finishReason: "tool_call",
        toolCalls: [{ id: "fixture-clock-biased-nonce-call", name: "submit_probe_nonce", input: { nonce: "2026-07-08T19:00:00Z" } }],
        usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 }
      };
    }
    return super.generate(request);
  }
}

class NonceLeakAwareAdapter extends ConformantFixtureAdapter {
  override async generate(request: GenerateRequest): Promise<GenerateResult> {
    if (request.requiredToolName === "submit_probe_nonce") {
      const toolResult = [...request.messages].reverse().find((message) => message.role === "tool");
      if (!toolResult) throw new Error("fixture_tool_result_missing");
      const parsed = JSON.parse(toolResult.content) as { nonce: string };
      const leaked = request.messages.some((message) => message.role !== "tool" && message.content.includes(parsed.nonce));
      if (leaked) {
        return {
          modelVersionId: profile.modelVersionId,
          content: "",
          finishReason: "tool_call",
          toolCalls: [{ id: "fixture-leaked-nonce-call", name: "submit_probe_nonce", input: { nonce: "LEAKED" } }],
          usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 }
        };
      }
    }
    return super.generate(request);
  }
}

describe("model conformance", () => {
  it("passes only when required native calls preserve opaque tool-result grounding", async () => {
    const report = await runModelConformance(new ConformantFixtureAdapter(), profile, { tokenSeed: "unit" });
    expect(report.allowed).toBe(true);
    expect(report.passed).toBe(report.cases);
    expect(report.failed).toBe(0);
    expect(report.results.find((result) => result.id === "native-tool-call")?.passed).toBe(true);
    expect(report.results.find((result) => result.id === "tool-result-continuation")?.passed).toBe(true);
  });

  it("isolates continuation grounding from current_time semantics", async () => {
    const report = await runModelConformance(new ClockBiasedContinuationAdapter(), profile, { tokenSeed: "intent" });
    expect(report.allowed).toBe(true);
    expect(report.results.find((result) => result.id === "tool-result-continuation")?.passed).toBe(true);
  });

  it("keeps the opaque nonce exclusive to the tool result", async () => {
    const report = await runModelConformance(new NonceLeakAwareAdapter(), profile, { tokenSeed: "secret" });
    expect(report.allowed).toBe(true);
    expect(report.results.find((result) => result.id === "tool-result-continuation")?.passed).toBe(true);
  });

  it("fails closed when a replacement model cannot produce required native tool calls", async () => {
    const report = await runModelConformance(new BrokenToolAdapter(), profile, { tokenSeed: "broken" });
    expect(report.allowed).toBe(false);
    expect(report.results.find((result) => result.id === "native-tool-call")?.passed).toBe(false);
    expect(report.results.find((result) => result.id === "tool-result-continuation")?.passed).toBe(false);
  });

  it("fails closed when the continuation tool call invents the opaque nonce and reports the observed value", async () => {
    const report = await runModelConformance(new UngroundedContinuationAdapter(), profile, { tokenSeed: "ungrounded" });
    const continuation = report.results.find((result) => result.id === "tool-result-continuation");
    expect(report.allowed).toBe(false);
    expect(report.results.find((result) => result.id === "native-tool-call")?.passed).toBe(true);
    expect(continuation?.passed).toBe(false);
    expect(continuation?.failures).toContain("tool_result_nonce_missing");
    expect(continuation?.failures).toContain("tool_result_nonce_observed:INVENTED_NONCE");
  });
});
