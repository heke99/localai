import { describe, expect, it } from "vitest";
import type { GenerateRequest, ModelToolDefinition } from "@div3rsa/model-sdk";
import { GenericOpenAiCompatibleAdapter } from "./generic-openai-compatible-adapter";
import { OpenAiCompatibleAdapter } from "./openai-compatible-adapter";

const continuationTool: ModelToolDefinition = {
  name: "record_tool_result",
  description: "Record a continuation token from prior tool evidence.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["continuationToken"],
    properties: { continuationToken: { type: "string" } }
  }
};

function request(overrides: Partial<GenerateRequest> = {}): GenerateRequest {
  return {
    requestId: "required-tool-test",
    alias: "general-prod",
    messages: [{ role: "user", content: "Use the required tool with the token from prior evidence." }],
    tools: [continuationTool],
    requiredToolName: continuationTool.name,
    maxOutputTokens: 64,
    temperature: 0,
    disableThinking: true,
    ...overrides
  };
}

describe("portable required-tool contract", () => {
  it("enforces the required tool through the Qwen llama.cpp grammar path", async () => {
    let wireBody: Record<string, unknown> | null = null;
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      wireBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        choices: [{
          message: { content: JSON.stringify({ name: continuationTool.name, arguments: { continuationToken: "TOKEN_QWEN" } }) },
          finish_reason: "stop"
        }],
        usage: { prompt_tokens: 10, completion_tokens: 4 }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const adapter = new OpenAiCompatibleAdapter("http://runtime/v1", "test-key", fetcher);
    const result = await adapter.generate(request());

    expect(wireBody?.json_schema).toBeDefined();
    expect(wireBody?.stream).toBe(false);
    expect(result.finishReason).toBe("tool_call");
    expect(result.content).toBe("");
    expect(result.toolCalls).toEqual([{ id: "required-tool-test:forced-tool", name: continuationTool.name, input: { continuationToken: "TOKEN_QWEN" } }]);
  });

  it("maps the same contract to native OpenAI tool_choice and validates the provider response", async () => {
    let wireBody: Record<string, unknown> | null = null;
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      wireBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: "",
            tool_calls: [{ id: "generic-call", type: "function", function: { name: continuationTool.name, arguments: JSON.stringify({ continuationToken: "TOKEN_GENERIC" }) } }]
          },
          finish_reason: "tool_calls"
        }],
        usage: { prompt_tokens: 10, completion_tokens: 4 }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const adapter = new GenericOpenAiCompatibleAdapter("http://runtime/v1", "test-key", {
      runtimeModel: "portable-model",
      modelVersionId: "portable-model-v1",
      capabilities: ["general", "tool_use"]
    }, fetcher);
    const result = await adapter.generate(request());

    expect(wireBody?.tool_choice).toEqual({ type: "function", function: { name: continuationTool.name } });
    expect(result.finishReason).toBe("tool_call");
    expect(result.toolCalls).toEqual([{ id: "generic-call", name: continuationTool.name, input: { continuationToken: "TOKEN_GENERIC" } }]);
  });

  it("fails closed when a generic provider ignores the required tool choice", async () => {
    const fetcher = (async () => new Response(JSON.stringify({
      choices: [{ message: { content: "I ignored the tool." }, finish_reason: "stop" }]
    }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;

    const adapter = new GenericOpenAiCompatibleAdapter("http://runtime/v1", "test-key", {
      runtimeModel: "portable-model",
      modelVersionId: "portable-model-v1",
      capabilities: ["general", "tool_use"]
    }, fetcher);

    await expect(adapter.generate(request())).rejects.toThrow(`required_tool_call_mismatch:${continuationTool.name}`);
  });

  it("fails before inference when the required tool is not exposed", async () => {
    let requests = 0;
    const fetcher = (async () => {
      requests += 1;
      throw new Error("network_should_not_run");
    }) as typeof fetch;
    const qwen = new OpenAiCompatibleAdapter("http://runtime/v1", "test-key", fetcher);
    const generic = new GenericOpenAiCompatibleAdapter("http://runtime/v1", "test-key", {
      runtimeModel: "portable-model",
      modelVersionId: "portable-model-v1",
      capabilities: ["general", "tool_use"]
    }, fetcher);
    const invalid = request({ requiredToolName: "missing_tool" });

    await expect(qwen.generate(invalid)).rejects.toThrow("required_tool_definition_missing:missing_tool");
    await expect(generic.generate(invalid)).rejects.toThrow("required_tool_definition_missing:missing_tool");
    expect(requests).toBe(0);
  });
});
