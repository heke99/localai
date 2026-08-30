import { expect, test } from "vitest";
import { OpenAiCompatibleAdapter } from "./openai-compatible-adapter";

const securityTool = {
  name: "security_scan",
  description: "bounded security runtime",
  inputSchema: { type: "object", required: ["tool", "target"], properties: { tool: { type: "string" }, target: { type: "string" } } }
};

test("forces security_scan only before readiness tool evidence exists", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const fetcher: typeof fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ choices: [{ message: { content: "", tool_calls: [{ id: "call-1", type: "function", function: { name: "security_scan", arguments: "{\"tool\":\"dns_lookup\",\"target\":\"127.0.0.1\"}" } }] }, finish_reason: "tool_calls" }], usage: {} }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const adapter = new OpenAiCompatibleAdapter("http://example.invalid/v1", "test", fetcher);
  await adapter.generate({
    requestId: "readiness-force-1",
    alias: "general-prod",
    messages: [
      { role: "system", content: "SECURITY READINESS REQUIRED: execute the requested security operation." },
      { role: "user", content: "Run dns_lookup." }
    ],
    tools: [securityTool]
  });
  expect(bodies[0]?.tool_choice).toEqual({ type: "function", function: { name: "security_scan" } });

  bodies.length = 0;
  await adapter.generate({
    requestId: "readiness-force-2",
    alias: "general-prod",
    messages: [
      { role: "system", content: "SECURITY READINESS REQUIRED: execute the requested security operation." },
      { role: "user", content: "Run dns_lookup." },
      { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "security_scan", input: { tool: "dns_lookup", target: "127.0.0.1" } }] },
      { role: "tool", name: "security_scan", toolCallId: "call-1", content: "{\"ok\":true}" }
    ],
    tools: [securityTool]
  });
  expect(bodies[0]?.tool_choice).toBe("auto");
});

test("does not force security_scan without the reserved readiness marker", async () => {
  let body: Record<string, unknown> | null = null;
  const fetcher: typeof fetch = async (_url, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ choices: [{ message: { content: "normal" }, finish_reason: "stop" }], usage: {} }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const adapter = new OpenAiCompatibleAdapter("http://example.invalid/v1", "test", fetcher);
  await adapter.generate({ requestId: "normal-lab", alias: "general-prod", messages: [{ role: "system", content: "Mode: lab." }, { role: "user", content: "Inspect the target." }], tools: [securityTool] });
  expect(body?.tool_choice).toBe("auto");
});
