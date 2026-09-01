import { describe, expect, it, vi } from "vitest";
import type { ModelToolDefinition } from "@div3rsa/model-sdk";
import { ExecutionGroundedOpenAiCompatibleAdapter } from "./execution-grounded-openai-compatible-adapter";

const webSearch: ModelToolDefinition = {
  name: "web_search",
  description: "Search current web sources",
  inputSchema: { type: "object", properties: { query: { type: "string" } } }
};

const webFetch: ModelToolDefinition = {
  name: "web_fetch",
  description: "Open a web source",
  inputSchema: { type: "object", properties: { url: { type: "string" } } }
};

function completion(content: string) {
  return new Response(JSON.stringify({
    choices: [{ message: { content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 12 }
  }), { status: 200, headers: { "content-type": "application/json" } });
}

describe("bounded current-information inference", () => {
  it("disables thinking and bounds the internal model pass after freshness preflight opened evidence", async () => {
    let requestBody: Record<string, unknown> | null = null;
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return completion("The current latest Node.js release is v26.8.1, verified from the opened official Node.js source.");
    });
    const adapter = new ExecutionGroundedOpenAiCompatibleAdapter("http://worker/v1", "internal", fetcher as typeof fetch);

    const output = await adapter.generate({
      requestId: "current-node-release",
      alias: "research-prod",
      messages: [
        {
          role: "system",
          content: "Mode: research. Reasoning policy: STANDARD: verify assumptions. CURRENT INFORMATION REQUIRED: verify material time-sensitive claims with current tools/sources. Research depth: standard."
        },
        {
          role: "user",
          content: "Find the current latest Node.js release from official Node.js information. Search the web, open the relevant source, and report the version you verified and that the information was checked now. Do not rely on model memory."
        },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "search-1", name: "web_search", input: { query: "site:nodejs.org current Node.js release" } }]
        },
        {
          role: "tool",
          name: "web_search",
          toolCallId: "search-1",
          content: "{\"results\":[{\"url\":\"https://nodejs.org/en/download/current\",\"title\":\"Node.js current\"}]}"
        },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "fetch-1", name: "web_fetch", input: { url: "https://nodejs.org/en/download/current" } }]
        },
        {
          role: "tool",
          name: "web_fetch",
          toolCallId: "fetch-1",
          content: "{\"url\":\"https://nodejs.org/en/download/current\",\"text\":\"Current release v26.8.1\"}"
        }
      ],
      tools: [webSearch, webFetch]
    });

    expect(fetcher).toHaveBeenCalledOnce();
    expect(requestBody).toMatchObject({
      max_tokens: 800,
      temperature: 0,
      reasoning_effort: "none",
      chat_template_kwargs: { enable_thinking: false },
      tool_choice: "auto"
    });
    expect(output.finishReason).toBe("stop");
    expect(output.content).toContain("v26.8.1");
  });
});
