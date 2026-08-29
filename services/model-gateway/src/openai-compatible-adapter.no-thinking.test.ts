import { describe, expect, it, vi } from "vitest";
import { OpenAiCompatibleAdapter } from "./openai-compatible-adapter";

describe("OpenAiCompatibleAdapter request-scoped thinking control", () => {
  it("sends llama.cpp no-thinking kwargs only when explicitly requested", async () => {
    const payloads: Record<string, unknown>[] = [];
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      payloads.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 }
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const adapter = new OpenAiCompatibleAdapter("http://worker/v1", "secret", fetcher as typeof fetch);

    await adapter.generate({
      requestId: "normal",
      alias: "general-prod",
      messages: [{ role: "user", content: "normal user request" }]
    });
    await adapter.generate({
      requestId: "shadow",
      alias: "verifier-prod",
      messages: [{ role: "user", content: "short verifier request" }],
      disableThinking: true
    });

    expect(payloads[0]).not.toHaveProperty("chat_template_kwargs");
    expect(payloads[1]).toMatchObject({
      reasoning_effort: "none",
      chat_template_kwargs: { enable_thinking: false }
    });
  });
});
