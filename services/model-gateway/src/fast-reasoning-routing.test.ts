import { describe, expect, it, vi } from "vitest";
import type { GenerateRequest, ModelToolDefinition } from "@div3rsa/model-sdk";
import { OpenAiCompatibleAdapter } from "./openai-compatible-adapter";

const tools: ModelToolDefinition[] = [
  { name: "current_time", description: "time", inputSchema: { type: "object" } },
  { name: "web_search", description: "search", inputSchema: { type: "object" } },
  { name: "web_fetch", description: "fetch", inputSchema: { type: "object" } }
];

function response() {
  return new Response(JSON.stringify({
    choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1 }
  }), { status: 200 });
}

async function bodyFor(messages: GenerateRequest["messages"], requestTools: ModelToolDefinition[] = tools) {
  let body: Record<string, unknown> | null = null;
  const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return response();
  });
  const adapter = new OpenAiCompatibleAdapter("http://worker/v1", "secret", fetcher as typeof fetch);
  await adapter.generate({ requestId: "req", alias: "general-prod", messages, tools: requestTools });
  return body as Record<string, unknown>;
}

describe("FAST reasoning routing", () => {
  it("disables hidden reasoning for stable FAST work even when optional tools are available", async () => {
    const body = await bodyFor([
      { role: "system", content: "Task risk: low. Reasoning policy: FAST: solve directly. STABLE INFORMATION: external research is optional. Research depth: none." },
      { role: "user", content: "What is 17 + 25?" }
    ]);
    expect(body.reasoning_effort).toBe("none");
    expect(body.tool_choice).toBe("auto");
  });

  it("keeps model reasoning enabled for FAST live-information work", async () => {
    const body = await bodyFor([
      { role: "system", content: "Task risk: low. Reasoning policy: FAST: solve directly. LIVE INFORMATION REQUIRED: use an available deterministic/live tool. Research depth: fast." },
      { role: "user", content: "Vad är klockan i Stockholm just nu?" }
    ]);
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it("keeps model reasoning enabled for STANDARD work", async () => {
    const body = await bodyFor([
      { role: "system", content: "Task risk: medium. Reasoning policy: STANDARD: decompose material subproblems. STABLE INFORMATION: external research is optional. Research depth: none." },
      { role: "user", content: "Analyze this architecture tradeoff." }
    ], []);
    expect(body).not.toHaveProperty("reasoning_effort");
  });
});
