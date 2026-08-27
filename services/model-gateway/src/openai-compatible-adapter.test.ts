import { describe, expect, it, vi } from "vitest";
import { OpenAiCompatibleAdapter } from "./openai-compatible-adapter";
import { QWEN_Q8, QWEN_RUNTIME_MODEL } from "./registry";

describe("OpenAiCompatibleAdapter", () => {
  it("uses the llama.cpp runtime model name and returns the canonical model version", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as { model?: string };
      expect(payload.model).toBe(QWEN_RUNTIME_MODEL);
      return new Response(JSON.stringify({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 4, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 1 } }
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const adapter = new OpenAiCompatibleAdapter("http://worker/v1", "internal", fetcher as typeof fetch);
    const result = await adapter.generate({ requestId: "req-1", alias: "general-prod", messages: [{ role: "user", content: "hello" }] });
    expect(result.modelVersionId).toBe(QWEN_Q8.id);
    expect(result.content).toBe("ok");
    expect(result.usage).toEqual({ inputTokens: 4, outputTokens: 2, cachedTokens: 1 });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("sends tool definitions and parses structured tool calls", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as { model?: string; tools?: unknown[] };
      expect(payload.model).toBe(QWEN_RUNTIME_MODEL);
      expect(payload.tools).toHaveLength(1);
      return new Response(JSON.stringify({
        choices: [{ message: { content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "github_read_file", arguments: '{"resourceId":"repo-1","path":"README.md"}' } }] }, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 5, completion_tokens: 3 }
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const adapter = new OpenAiCompatibleAdapter("http://worker/v1", "internal", fetcher as typeof fetch);
    const result = await adapter.generate({
      requestId: "req-tools",
      alias: "code-prod",
      messages: [{ role: "user", content: "read the repo" }],
      tools: [{ name: "github_read_file", description: "Read a file", inputSchema: { type: "object", required: ["resourceId", "path"] } }]
    });
    expect(result.finishReason).toBe("tool_call");
    expect(result.toolCalls).toEqual([{ id: "call-1", name: "github_read_file", input: { resourceId: "repo-1", path: "README.md" } }]);
  });

  it("fails closed when the worker has no valid choice", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ choices: [] }), { status: 200 }));
    const adapter = new OpenAiCompatibleAdapter("http://worker/v1", "internal", fetcher as typeof fetch);
    await expect(adapter.generate({ requestId: "req-2", alias: "general-prod", messages: [] })).rejects.toThrow("no choices");
  });

  it("propagates the run abort signal to llama.cpp generation", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal);
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    });
    const adapter = new OpenAiCompatibleAdapter("http://worker/v1", "internal", fetcher as typeof fetch);
    await expect(adapter.generate({
      requestId: "req-cancel",
      alias: "general-prod",
      messages: [{ role: "user", content: "long answer" }],
      signal: controller.signal
    })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("parses fragmented SSE streaming responses", async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      'data: [DONE]\n\n'
    ];
    const stream = new ReadableStream({ start(controller) { chunks.forEach((chunk) => controller.enqueue(new TextEncoder().encode(chunk))); controller.close(); } });
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as { model?: string };
      expect(payload.model).toBe(QWEN_RUNTIME_MODEL);
      return new Response(stream, { status: 200 });
    });
    const adapter = new OpenAiCompatibleAdapter("http://worker/v1", "secret", fetcher as typeof fetch);
    const output: string[] = [];
    for await (const chunk of adapter.stream({ requestId: "req-stream", alias: "general-prod", messages: [{ role: "user", content: "Hi" }] })) output.push(chunk);
    expect(output.join("")).toBe("Hello");
  });
});
