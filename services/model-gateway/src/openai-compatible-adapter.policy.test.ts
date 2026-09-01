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

function schemaToolName(body: Record<string, unknown>): string | null {
  const schema = body.json_schema;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return null;
  const properties = (schema as { properties?: unknown }).properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return null;
  const name = (properties as { name?: unknown }).name;
  if (!name || typeof name !== "object" || Array.isArray(name)) return null;
  const values = (name as { enum?: unknown }).enum;
  return Array.isArray(values) && typeof values[0] === "string" ? values[0] : null;
}

function requestedTool(body: Record<string, unknown>): string | null {
  const schemaName = schemaToolName(body);
  if (schemaName) return schemaName;
  if (body.tool_choice === "auto" && Array.isArray(body.tools)) return "auto";
  return null;
}

function responseFor(body: Record<string, unknown>) {
  const forced = schemaToolName(body);
  return forced
    ? { choices: [{ message: { content: JSON.stringify({ name: forced, arguments: forced === "current_time" ? { timezone: "Europe/Stockholm" } : {} }) }, finish_reason: "stop" }] }
    : { choices: [{ message: { content: "ok" }, finish_reason: "stop" }] };
}

describe("OpenAI-compatible runtime policy", () => {
  it("forces deterministic current_time through a schema before answering a live clock request", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(requestedTool(body)).toBe("current_time");
      expect(body.tools).toBeUndefined();
      expect(body.tool_choice).toBeUndefined();
      return new Response(JSON.stringify(responseFor(body)), { status: 200 });
    });
    const adapter = new OpenAiCompatibleAdapter("http://worker/v1", "secret", fetcher as typeof fetch);
    const result = await adapter.generate(request([
      { role: "system", content: "Task risk: low. Reasoning policy: FAST. LIVE INFORMATION REQUIRED: use an available deterministic/live tool. Research depth: fast." },
      { role: "user", content: "Vad är klockan i Stockholm just nu?" }
    ]));
    expect(result.finishReason).toBe("tool_call");
    expect(result.toolCalls?.[0]).toMatchObject({ name: "current_time", input: { timezone: "Europe/Stockholm" } });
  });

  it("forces current_time for the exact production date-and-time canary phrasing", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(requestedTool(body)).toBe("current_time");
      expect(body.tools).toBeUndefined();
      expect(body.tool_choice).toBeUndefined();
      return new Response(JSON.stringify(responseFor(body)), { status: 200 });
    });
    const adapter = new OpenAiCompatibleAdapter("http://worker/v1", "secret", fetcher as typeof fetch);
    const result = await adapter.generate(request([
      { role: "system", content: "LIVE INFORMATION REQUIRED: use an available deterministic/live tool. Never guess a realtime value from model memory." },
      { role: "user", content: "What is the current date and time in Europe/Stockholm? Use the current_time tool." }
    ]));
    expect(result.finishReason).toBe("tool_call");
    expect(result.toolCalls?.[0]).toMatchObject({ name: "current_time", input: { timezone: "Europe/Stockholm" } });
  });

  it("forces search then opened source through schemas for changing current facts", async () => {
    const choices: Array<string | null> = [];
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      choices.push(requestedTool(body));
      return new Response(JSON.stringify(responseFor(body)), { status: 200 });
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
      return new Response(JSON.stringify(responseFor(body)), { status: 200 });
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

  it("disables thinking and caps output for clean-room evidence synthesis", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.reasoning_effort).toBe("none");
      expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
      expect(body.max_tokens).toBe(600);
      expect(body.tools).toEqual([]);
      return new Response(JSON.stringify({ choices: [{ message: { content: "25% according to Skatteverket." }, finish_reason: "stop" }] }), { status: 200 });
    });
    const adapter = new OpenAiCompatibleAdapter("http://worker/v1", "secret", fetcher as typeof fetch);
    const result = await adapter.generate({
      requestId: "evidence-synthesis",
      alias: "research-prod",
      messages: [
        { role: "system", content: "You are a clean-room final-answer synthesizer. Tool execution is finished and no tools are available." },
        { role: "user", content: "Use only the opened evidence and answer directly." }
      ],
      tools: [],
      temperature: 0,
      maxOutputTokens: 1200
    });
    expect(result.content).toContain("25%");
  });

  it("does not stream forced-tool schema JSON to the user", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.stream).toBe(false);
      return new Response(JSON.stringify(responseFor(body)), { status: 200 });
    });
    const adapter = new OpenAiCompatibleAdapter("http://worker/v1", "secret", fetcher as typeof fetch);
    const deltas: string[] = [];
    const result = await adapter.generateStreamed!(request([
      { role: "system", content: "Task risk: low. Reasoning policy: FAST. LIVE INFORMATION REQUIRED: use an available deterministic/live tool. Research depth: fast." },
      { role: "user", content: "Vad är klockan i Stockholm just nu?" }
    ]), (delta) => { deltas.push(delta); });
    expect(deltas).toEqual([]);
    expect(result.finishReason).toBe("tool_call");
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
      (delta) => { deltas.push(delta); });
    expect(deltas.join("")).toBe("Visible answer");
    expect(result.content).toBe("Visible answer");
    expect(result.content).not.toContain("hidden");
    expect(result.content).not.toContain("private reasoning");
  });
});
