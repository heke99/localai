import { describe, expect, it } from "vitest";
import type { GenerateRequest, ModelToolDefinition } from "@div3rsa/model-sdk";
import { createInferenceAdapter, modelProtocolProfileFromEnvironment } from "./adapter-factory";
import { GenericOpenAiCompatibleAdapter } from "./generic-openai-compatible-adapter";

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

const singletonTool: ModelToolDefinition = {
  name: "fixed_probe",
  description: "Run the single deterministic probe mode allowed by this contract.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["mode"],
    properties: { mode: { type: "string", enum: ["copy-once"] } }
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

function qwenAdapter(fetcher: typeof fetch) {
  return createInferenceAdapter({
    baseUrl: "http://runtime/v1",
    apiKey: "test-key",
    profile: modelProtocolProfileFromEnvironment({}),
    fetcher
  });
}

describe("portable required-tool contract", () => {
  it("uses native llama.cpp tool history for explicit required Qwen continuation", async () => {
    const wireBodies: Record<string, unknown>[] = [];
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      wireBodies.push(body);
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: "qwen-native-call",
              type: "function",
              function: { name: continuationTool.name, arguments: JSON.stringify({ continuationToken: "TOKEN_QWEN" }) }
            }]
          },
          finish_reason: "tool_calls"
        }],
        usage: { prompt_tokens: 10, completion_tokens: 4 }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const adapter = qwenAdapter(fetcher);
    const result = await adapter.generate(request({
      messages: [
        { role: "system", content: "Copy only the authoritative token returned by the prior tool." },
        { role: "user", content: "Start the source tool." },
        { role: "assistant", content: "", toolCalls: [{ id: "prior-source-call", name: "source_tool", input: { probe: "copy" } }] },
        { role: "tool", name: "source_tool", toolCallId: "prior-source-call", content: JSON.stringify({ continuationToken: "TOKEN_QWEN" }) },
        { role: "user", content: "Now copy the token into the required tool." }
      ]
    }));

    const body = wireBodies[0];
    expect(body?.json_schema).toBeUndefined();
    expect(body?.tool_choice).toBe("required");
    expect(body?.reasoning_effort).toBe("none");
    expect(body?.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(body?.cache_prompt).toBe(true);
    expect(body?.stream).toBe(false);

    const tools = body?.tools as Array<{ function?: { name?: string } }>;
    expect(tools).toHaveLength(1);
    expect(tools[0]?.function?.name).toBe(continuationTool.name);

    const messages = body?.messages as Array<Record<string, unknown>>;
    expect(messages).toContainEqual({
      role: "tool",
      content: JSON.stringify({ continuationToken: "TOKEN_QWEN" }),
      tool_call_id: "prior-source-call",
      name: "source_tool"
    });

    expect(result.finishReason).toBe("tool_call");
    expect(result.content).toBe("");
    expect(result.toolCalls).toEqual([{ id: "qwen-native-call", name: continuationTool.name, input: { continuationToken: "TOKEN_QWEN" } }]);
  });

  it("retries a missing required Qwen tool once with thinking enabled", async () => {
    const wireBodies: Record<string, unknown>[] = [];
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      wireBodies.push(body);
      if (wireBodies.length === 1) {
        return new Response(JSON.stringify({
          choices: [{ message: { content: "I ignored the tool." }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 4 }
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: "qwen-thinking-retry",
              type: "function",
              function: { name: continuationTool.name, arguments: JSON.stringify({ continuationToken: "TOKEN_RETRY" }) }
            }]
          },
          finish_reason: "tool_calls"
        }],
        usage: { prompt_tokens: 12, completion_tokens: 5 }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const result = await qwenAdapter(fetcher).generate(request());

    expect(wireBodies).toHaveLength(2);
    expect(wireBodies[0]?.tool_choice).toBe("required");
    expect(wireBodies[0]?.reasoning_effort).toBe("none");
    expect(wireBodies[0]?.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(wireBodies[1]?.tool_choice).toBe("required");
    expect(wireBodies[1]?.reasoning_effort).toBeUndefined();
    expect(wireBodies[1]?.chat_template_kwargs).toEqual({ enable_thinking: true });
    const retryTools = wireBodies[1]?.tools as Array<{ function?: { name?: string } }>;
    expect(retryTools).toHaveLength(1);
    expect(retryTools[0]?.function?.name).toBe(continuationTool.name);
    expect(result.finishReason).toBe("tool_call");
    expect(result.toolCalls).toEqual([{ id: "qwen-thinking-retry", name: continuationTool.name, input: { continuationToken: "TOKEN_RETRY" } }]);
  });

  it("falls back to Qwen schema grammar only for a closed singleton required tool", async () => {
    const wireBodies: Record<string, unknown>[] = [];
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      wireBodies.push(body);
      if (wireBodies.length <= 2) {
        return new Response(JSON.stringify({
          choices: [{ message: { content: "I ignored the tool." }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 4 }
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        choices: [{
          message: { content: JSON.stringify({ name: singletonTool.name, arguments: { mode: "copy-once" } }) },
          finish_reason: "stop"
        }],
        usage: { prompt_tokens: 12, completion_tokens: 5 }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const result = await qwenAdapter(fetcher).generate(request({
      tools: [singletonTool],
      requiredToolName: singletonTool.name,
      messages: [{ role: "user", content: "Run the fixed probe." }]
    }));

    expect(wireBodies).toHaveLength(3);
    expect(wireBodies[0]?.tool_choice).toBe("required");
    expect(wireBodies[1]?.tool_choice).toBe("required");
    expect(wireBodies[2]?.tools).toBeUndefined();
    expect(wireBodies[2]?.tool_choice).toBeUndefined();
    expect(wireBodies[2]?.json_schema).toBeDefined();
    expect(wireBodies[2]?.reasoning_effort).toBe("none");
    expect(wireBodies[2]?.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(result.finishReason).toBe("tool_call");
    expect(result.content).toBe("");
    expect(result.toolCalls).toEqual([{ id: "required-tool-test:forced-tool", name: singletonTool.name, input: { mode: "copy-once" } }]);
  });

  it("fails closed when Qwen ignores a required tool with evidence-derived arguments", async () => {
    const wireBodies: Record<string, unknown>[] = [];
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      wireBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({
        choices: [{ message: { content: "I ignored the tool." }, finish_reason: "stop" }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    await expect(qwenAdapter(fetcher).generate(request())).rejects.toThrow(`required_tool_call_mismatch:${continuationTool.name}`);
    expect(wireBodies).toHaveLength(2);
    expect(wireBodies.every((body) => body.json_schema === undefined)).toBe(true);
  });

  it("maps the same contract to native OpenAI tool_choice and validates the provider response", async () => {
    const wireBodies: Record<string, unknown>[] = [];
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      wireBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
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

    expect(wireBodies[0]?.tool_choice).toEqual({ type: "function", function: { name: continuationTool.name } });
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
    const qwen = qwenAdapter(fetcher);
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
