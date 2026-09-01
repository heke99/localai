import { describe, expect, it, vi } from "vitest";
import { createInferenceAdapter, modelProtocolProfileFromEnvironment } from "./adapter-factory";

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("portable inference adapter factory", () => {
  it("keeps the verified Qwen protocol as the backwards-compatible default", () => {
    const profile = modelProtocolProfileFromEnvironment({});
    expect(profile.protocol).toBe("qwen-llamacpp");
    expect(profile.modelVersionId).toBe("qwen38-27b-obliterated-v3-q8-0");
    expect(profile.capabilities).toContain("tool_use");
    expect(profile.protocolCapabilities).toContain("tool_result_continuation");
  });

  it("describes a replacement OpenAI-compatible model without importing Qwen identity", () => {
    const profile = modelProtocolProfileFromEnvironment({
      DIV3RSA_INFERENCE_PROTOCOL: "generic-openai",
      DIV3RSA_INFERENCE_MODEL_NAME: "replacement-model",
      DIV3RSA_INFERENCE_MODEL_VERSION_ID: "replacement-model-v1",
      DIV3RSA_INFERENCE_MODEL_CAPABILITIES: "general,reasoning,coding,tool_use,verification"
    });

    expect(profile).toMatchObject({
      protocol: "generic-openai",
      runtimeModel: "replacement-model",
      modelVersionId: "replacement-model-v1"
    });
    expect(profile.capabilities).toContain("tool_use");
  });

  it("uses standard native tool_choice and omits Qwen-only request fields for generic models", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.model).toBe("replacement-model");
      expect(body.reasoning_effort).toBeUndefined();
      expect(body.chat_template_kwargs).toBeUndefined();
      expect(body.cache_prompt).toBeUndefined();
      expect(body.json_schema).toBeUndefined();
      expect(body.tool_choice).toEqual({ type: "function", function: { name: "current_time" } });
      return jsonResponse({
        choices: [{
          message: { content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "current_time", arguments: "{\"timezone\":\"Europe/Stockholm\"}" } }] },
          finish_reason: "tool_calls"
        }],
        usage: { prompt_tokens: 12, completion_tokens: 4 }
      });
    });
    const profile = modelProtocolProfileFromEnvironment({
      DIV3RSA_INFERENCE_PROTOCOL: "generic-openai",
      DIV3RSA_INFERENCE_MODEL_NAME: "replacement-model",
      DIV3RSA_INFERENCE_MODEL_VERSION_ID: "replacement-model-v1",
      DIV3RSA_INFERENCE_MODEL_CAPABILITIES: "general,tool_use"
    });
    const adapter = createInferenceAdapter({ baseUrl: "https://inference.example/v1", apiKey: "test", profile, fetcher: fetcher as typeof fetch });

    const result = await adapter.generate({
      requestId: "portable-tool-test",
      alias: "general-prod",
      messages: [
        { role: "system", content: "LIVE INFORMATION REQUIRED: use an available deterministic/live tool." },
        { role: "user", content: "What is the current time in Europe/Stockholm?" }
      ],
      tools: [{
        name: "current_time",
        description: "Return current time",
        inputSchema: { type: "object", additionalProperties: false, required: ["timezone"], properties: { timezone: { type: "string" } } }
      }]
    });

    expect(result.modelVersionId).toBe("replacement-model-v1");
    expect(result.finishReason).toBe("tool_call");
    expect(result.toolCalls?.[0]).toMatchObject({ name: "current_time", input: { timezone: "Europe/Stockholm" } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
