import { describe, expect, it, vi } from "vitest";
import type { ModelToolDefinition } from "@div3rsa/model-sdk";
import { StrictToolProtocolOpenAiCompatibleAdapter } from "./strict-tool-protocol-openai-compatible-adapter";

const securityTool: ModelToolDefinition = {
  name: "security_scan",
  description: "Authorized bounded Lab executor. Executable security plan: 1:http_probe -> 2:tls_probe -> 3:dns_lookup",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["tool", "target", "options"],
    properties: {
      tool: { type: "string", enum: ["http_probe", "tls_probe", "dns_lookup"] },
      target: { type: "string" },
      options: { type: "object" }
    }
  }
};

const webSearchTool: ModelToolDefinition = {
  name: "web_search",
  description: "Research-only web search",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["query"],
    properties: { query: { type: "string" } }
  }
};

const webFetchTool: ModelToolDefinition = {
  name: "web_fetch",
  description: "Open public research source",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["url"],
    properties: { url: { type: "string" } }
  }
};

function completion(content: string, finishReason = "stop") {
  return new Response(JSON.stringify({
    choices: [{ message: { content }, finish_reason: finishReason }],
    usage: { prompt_tokens: 10, completion_tokens: 4 }
  }), { status: 200, headers: { "content-type": "application/json" } });
}

const malformedEmptyWebSearch = [
  "<tool_call>",
  "<function=web_search>",
  "</function>",
  "</tool_call>"
].join("\n");

describe("strict tool protocol boundary", () => {
  it("recovers the exact live Lab malformed web_search after the model repeats it during security repair", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(completion(malformedEmptyWebSearch))
      .mockResolvedValueOnce(completion(malformedEmptyWebSearch));
    const adapter = new StrictToolProtocolOpenAiCompatibleAdapter("http://worker/v1", "internal", fetcher as typeof fetch);

    const output = await adapter.generate({
      requestId: "live-malformed-web-search",
      alias: "lab-prod",
      messages: [{
        role: "user",
        content: "Kör penetration mot https://target.localai.test inom uttryckligt auktoriserad labb-scope."
      }],
      tools: [securityTool, webSearchTool]
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(output.finishReason).toBe("tool_call");
    expect(output.content).toBe("");
    expect(output.toolCalls).toHaveLength(1);
    expect(output.toolCalls?.[0]).toMatchObject({
      name: "security_scan",
      input: { tool: "http_probe", target: "https://target.localai.test", options: {} }
    });
  });

  it("does not stream repeated malformed Lab tool markup before deterministic recovery", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(completion(malformedEmptyWebSearch))
      .mockResolvedValueOnce(completion(malformedEmptyWebSearch));
    const adapter = new StrictToolProtocolOpenAiCompatibleAdapter("http://worker/v1", "internal", fetcher as typeof fetch);
    const deltas: string[] = [];

    const output = await adapter.generateStreamed({
      requestId: "live-malformed-stream",
      alias: "lab-prod",
      messages: [{ role: "user", content: "Kör penetration mot https://target.localai.test i auktoriserat labb." }],
      tools: [securityTool, webSearchTool]
    }, async (delta) => { deltas.push(delta); });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(output.finishReason).toBe("tool_call");
    expect(output.toolCalls?.[0]?.name).toBe("security_scan");
    expect(deltas).toEqual([]);
  });

  it("recognizes bare Swedish penetration as execution intent at the final boundary", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(completion(malformedEmptyWebSearch));
    const adapter = new StrictToolProtocolOpenAiCompatibleAdapter("http://worker/v1", "internal", fetcher as typeof fetch);

    const output = await adapter.generate({
      requestId: "bare-penetration",
      alias: "lab-prod",
      messages: [{ role: "user", content: "Penetration mot https://target.localai.test inom auktoriserat labb-scope." }],
      tools: [securityTool, webSearchTool]
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(output.finishReason).toBe("tool_call");
    expect(output.toolCalls?.[0]).toMatchObject({
      name: "security_scan",
      input: { tool: "http_probe", target: "https://target.localai.test", options: {} }
    });
  });

  it("repairs an incomplete generic web_search by requiring its query field", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(completion(malformedEmptyWebSearch))
      .mockImplementationOnce(async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { messages: Array<{ content?: string | null }> };
        expect(body.messages.some((message) => typeof message.content === "string" && message.content.includes("Tool-protocol repair"))).toBe(true);
        expect(body.messages.some((message) => typeof message.content === "string" && message.content.includes("web_search{required:[query]"))).toBe(true);
        return completion("<tool_call>\n<function=web_search>\n<parameter=query>synthetic current information</parameter>\n</function>\n</tool_call>");
      });
    const adapter = new StrictToolProtocolOpenAiCompatibleAdapter("http://worker/v1", "internal", fetcher as typeof fetch);

    const output = await adapter.generate({
      requestId: "generic-web-search-repair",
      alias: "general-prod",
      messages: [{ role: "user", content: "Sök aktuell syntetisk information." }],
      tools: [webSearchTool]
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(output.finishReason).toBe("tool_call");
    expect(output.toolCalls).toEqual([{
      id: "text-tool-call-0",
      name: "web_search",
      input: { query: "synthetic current information" }
    }]);
    expect(output.content).toBe("");
  });

  it("returns a blank stop signal for deterministic worker fallback when internal evidence repair malforms twice", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(completion(malformedEmptyWebSearch))
      .mockResolvedValueOnce(completion(malformedEmptyWebSearch));
    const adapter = new StrictToolProtocolOpenAiCompatibleAdapter("http://worker/v1", "internal", fetcher as typeof fetch);

    const output = await adapter.generate({
      requestId: "current-evidence-malformed-twice",
      alias: "general-prod",
      messages: [
        { role: "user", content: "Vad är den aktuella svenska momssatsen?" },
        { role: "assistant", content: "25%." },
        {
          role: "user",
          content: "The independent current-information evidence reviewer rejected the candidate answer because the opened evidence is not sufficient. Reviewer reason: stronger primary evidence required.\n\nDo not merely rewrite the answer and do not use model memory as a substitute for evidence. Gather additional or stronger current evidence now."
        }
      ],
      tools: [webSearchTool, webFetchTool]
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(output.finishReason).toBe("stop");
    expect(output.content).toBe("");
    expect(output.toolCalls).toBeUndefined();
    expect(output.usage).toEqual({ inputTokens: 20, outputTokens: 8, cachedTokens: 0 });
  });

  it("fails closed when a non-internal repair attempt emits malformed tool protocol again", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(completion(malformedEmptyWebSearch))
      .mockResolvedValueOnce(completion(malformedEmptyWebSearch));
    const adapter = new StrictToolProtocolOpenAiCompatibleAdapter("http://worker/v1", "internal", fetcher as typeof fetch);

    await expect(adapter.generate({
      requestId: "malformed-twice",
      alias: "general-prod",
      messages: [{ role: "user", content: "Sök syntetisk information." }],
      tools: [webSearchTool]
    })).rejects.toThrow("model_invalid_tool_protocol_after_repair");
  });
});
