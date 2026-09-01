import { describe, expect, it, vi } from "vitest";
import type { GenerateRequest, ModelToolDefinition } from "@div3rsa/model-sdk";
import { OpenAiCompatibleAdapter } from "./openai-compatible-adapter";

const tools: ModelToolDefinition[] = [
  { name: "current_time", description: "time", inputSchema: { type: "object" } },
  { name: "web_search", description: "search", inputSchema: { type: "object" } },
  { name: "web_fetch", description: "fetch", inputSchema: { type: "object" } }
];

function request(messages: GenerateRequest["messages"]): GenerateRequest {
  return { requestId: "req", alias: "research-prod", messages, tools };
}

function requestedTool(body: Record<string, unknown>): string | null {
  if (body.tool_choice !== "auto" || !Array.isArray(body.tools)) return null;
  if (body.tools.length !== 1) return "auto";
  const tool = body.tools[0];
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) return null;
  const fn = (tool as { function?: unknown }).function;
  if (!fn || typeof fn !== "object" || Array.isArray(fn)) return null;
  const name = (fn as { name?: unknown }).name;
  return typeof name === "string" ? name : null;
}

describe("OpenAI-compatible runtime policy", () => {
  it("scopes deterministic current_time before answering a live clock request", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(requestedTool(body)).toBe("current_time");
      return new Response(JSON.stringify({
        choices: [{ message: { content: null, tool_calls: [{ id: "time-1", type: "function", function: { name: "current_time", arguments: '{"timezone":"Europe/Stockholm"}' } }] }, finish_reason: "tool_calls" }]
      }), { status: 200 });
    });
    const adapter = new OpenAiCompatibleAdapter("http://worker/v1", "secret", fetcher as typeof fetch);
    const result = await adapter.generate(request([
      { role: "system", content: "Task risk: low. Reasoning policy: FAST. LIVE INFORMATION REQUIRED: use an available deterministic/live tool. Research depth: fast." },
      { role: "user", content: "Vad är klockan i Stockholm just nu?" }
    ]));
    expect(result.toolCalls?.[0]?.name).toBe("current_time");
  });

  it("scopes search then opened source for changing current facts", async () => {
    const choices: Array<string | null> = [];
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      choices.push(requestedTool(body));
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }), { status: 200 });
    });
    const adapter = new OpenAiCompatibleAdapter("http://worker/v1", "secret", fetcher as typeof fetch);
    const system = { role: "system" as const, content: "Task risk: low. Reasoning policy: STANDARD. CURRENT INFORMATION REQUIRED: verify current claims. Research depth: standard." };
    const user = { role: "user" as const, content: "Vilken Node.js-version är aktuell just nu?" };

    await adapter.generate(request([system, user]));
    await adapter.generate(request([
      system,
      user,
      { role: "assistant", content: "", toolCalls: [{ id: "s1", name: "web_search", input: { query: "Node.js current version" } }] },
      { role: "tool", name: "web_search", toolCallId: "s1", content: '{"results":[{"url":"https://nodejs.org/en/download"}]}' }
    ]));
    await adapter.generate(request([
      system,
      user,
      { role: "assistant", content: "", toolCalls: [{ id: "s1", name: "web_search", input: { query: "Node.js current version" } }] },
      { role: "tool", name: "web_search", toolCallId: "s1", content: '{"results":[{"url":"https://nodejs.org/en/download"}]}' },
      { role: "assistant", content: "", toolCalls: [{ id: "f1", name: "web_fetch", input: { url: "https://nodejs.org/en/download" } }] },
      { role: "tool", name: "web_fetch", toolCallId: "f1", content: '{"url":"https://nodejs.org/en/download"}' }
    ]));

    expect(choices).toEqual(["web_search", "web_fetch", "auto"]);
  });

  it("requires two opened sources for deep current research", async () => {
    const choices: Array<string | null> = [];
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      choices.push(requestedTool(body));
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }), { status: 200 });
    });
    const adapter = new OpenAiCompatibleAdapter("http://worker/v1", "secret", fetcher as typeof fetch);
    const messages: GenerateRequest["messages"] = [
      { role: "system", content: "Task risk: low. Reasoning policy: DEEP. CURRENT INFORMATION REQUIRED: verify current claims. Research depth: deep." },
      { role: "user", content: "Jämför de senaste runtime-versionerna." },
      { role: "tool", name: "web_search", toolCallId: "s1", content: '{"results":[]}' },
      { role: "tool", name: "web_fetch", toolCallId: "f1", content: '{"url":"https://nodejs.org"}' }
    ];
    await adapter.generate(request(messages));
    await adapter.generate(request([...messages, { role: "tool", name: "web_fetch", toolCallId: "f2", content: '{"url":"https://deno.com"}' }]));
    expect(choices).toEqual(["web_fetch", "auto"]);
  });

  it("never streams internal think blocks or reasoning_content", async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"reasoning_content":"private reasoning","content":"<thi"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"content":"nk>hidden chain"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"content":"</think>Visible "},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n'
    ];
    const stream = new ReadableStream({ start(controller) { chunks.forEach((chunk) => controller.enqueue(new TextEncoder().encode(chunk))); controller.close(); } });
    const fetcher = vi.fn(async () => new Response(stream, { status: 200 }));
    const adapter = new OpenAiCompatibleAdapter("http://worker/v1", "secret", fetcher as typeof fetch);
    const deltas: string[] = [];
    const result = await adapter.generateStreamed!(
      { requestId: "reasoning-hidden", alias: "general-prod", messages: [{ role: "user", content: "hello" }] },
      (delta) => { deltas.push(delta); }
    );
    expect(deltas.join("")).toBe("Visible answer");
    expect(result.content).toBe("Visible answer");
    expect(result.content).not.toContain("hidden");
    expect(result.content).not.toContain("private reasoning");
  });
});
