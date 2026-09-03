import { describe, expect, it } from "vitest";
import type { GenerateRequest, ModelToolDefinition } from "@div3rsa/model-sdk";
import { createInferenceAdapter, modelProtocolProfileFromEnvironment } from "./adapter-factory";

const continuationTool: ModelToolDefinition = {
  name: "submit_probe_nonce",
  description: "Copy the nonce from the immediately preceding runtime tool result.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["nonce"],
    properties: { nonce: { type: "string" } }
  }
};

function qwenAdapter(fetcher: typeof fetch) {
  return createInferenceAdapter({
    baseUrl: "http://runtime/v1",
    apiKey: "test-key",
    profile: modelProtocolProfileFromEnvironment({}),
    fetcher
  });
}

function continuationRequest(toolResult: Record<string, unknown>): GenerateRequest {
  return {
    requestId: "copy-fallback-test",
    alias: "general-prod",
    temperature: 0,
    maxOutputTokens: 64,
    disableThinking: true,
    requiredToolName: continuationTool.name,
    tools: [continuationTool],
    messages: [
      { role: "system", content: "Copy only the authoritative nonce returned by the runtime tool." },
      { role: "user", content: "Start the source probe." },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "source-call", name: "probe_nonce_source", input: { probe: "copy-once" } }]
      },
      {
        role: "tool",
        name: "probe_nonce_source",
        toolCallId: "source-call",
        content: JSON.stringify(toolResult)
      },
      { role: "user", content: "Call submit_probe_nonce and copy the nonce exactly." }
    ]
  };
}

describe("Qwen required-tool result copy fallback", () => {
  it("binds an exact same-key runtime tool value into the schema grammar after native retries fail", async () => {
    const expectedNonce = "NX_RUNTIME_AUTHORITATIVE";
    const wireBodies: Record<string, unknown>[] = [];
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      wireBodies.push(body);

      if (wireBodies.length <= 2) {
        return new Response(JSON.stringify({
          choices: [{ message: { content: "I ignored the required tool." }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 4 }
        }), { status: 200, headers: { "content-type": "application/json" } });
      }

      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({ name: continuationTool.name, arguments: { nonce: expectedNonce } })
          },
          finish_reason: "stop"
        }],
        usage: { prompt_tokens: 12, completion_tokens: 5 }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const result = await qwenAdapter(fetcher).generate(continuationRequest({ nonce: expectedNonce }));

    expect(wireBodies).toHaveLength(3);
    expect(wireBodies[0]?.tool_choice).toBe("required");
    expect(wireBodies[1]?.tool_choice).toBe("required");
    expect(wireBodies[2]?.tools).toBeUndefined();
    expect(wireBodies[2]?.tool_choice).toBeUndefined();
    expect(wireBodies[2]?.reasoning_effort).toBe("none");
    expect(wireBodies[2]?.chat_template_kwargs).toEqual({ enable_thinking: false });

    const schema = wireBodies[2]?.json_schema as {
      properties?: {
        arguments?: {
          properties?: { nonce?: { enum?: unknown[] } };
        };
      };
    };
    expect(schema.properties?.arguments?.properties?.nonce?.enum).toEqual([expectedNonce]);

    expect(result.finishReason).toBe("tool_call");
    expect(result.content).toBe("");
    expect(result.toolCalls).toEqual([{
      id: "copy-fallback-test:forced-tool",
      name: continuationTool.name,
      input: { nonce: expectedNonce }
    }]);
  });

  it("remains fail-closed when the latest runtime tool result cannot authorize the required argument", async () => {
    const wireBodies: Record<string, unknown>[] = [];
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      wireBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({
        choices: [{ message: { content: "I ignored the required tool." }, finish_reason: "stop" }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    await expect(qwenAdapter(fetcher).generate(continuationRequest({ differentField: "NX_NOT_AUTHORIZED" })))
      .rejects.toThrow(`required_tool_call_mismatch:${continuationTool.name}`);

    expect(wireBodies).toHaveLength(2);
    expect(wireBodies.every((body) => body.json_schema === undefined)).toBe(true);
  });
});
