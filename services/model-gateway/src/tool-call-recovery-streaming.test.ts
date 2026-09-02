import { describe, expect, it } from "vitest";
import type { GenerateRequest, ModelAdapter } from "@div3rsa/model-sdk";
import { ToolCallRecoveryAdapter } from "./tool-call-recovery-adapter";

const request: GenerateRequest = {
  requestId: "stream-truncation",
  alias: "general-prod",
  messages: [{ role: "user", content: "Give me the complete answer" }]
};

describe("ToolCallRecoveryAdapter streaming terminal guards", () => {
  it("fails the run when a no-tool streamed response ends because of output length", async () => {
    const inner: ModelAdapter = {
      async generate() { throw new Error("unexpected_non_streaming_call"); },
      async generateStreamed(_request, onDelta) {
        await onDelta("partial answer");
        return {
          modelVersionId: "m",
          content: "partial answer",
          finishReason: "length",
          usage: { inputTokens: 1, outputTokens: 10, cachedTokens: 0 }
        };
      },
      async *stream() { yield "unused"; },
      async estimateTokens() { return 1; },
      getCapabilities() { return new Set(["general"] as const); },
      async healthCheck() { return { ok: true, latencyMs: 1 }; }
    };
    const adapter = new ToolCallRecoveryAdapter(inner);
    const deltas: string[] = [];

    await expect(adapter.generateStreamed!(request, (delta) => { deltas.push(delta); })).rejects.toThrow("model_output_truncated");
    expect(deltas).toEqual(["partial answer"]);
  });
});
