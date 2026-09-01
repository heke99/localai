import { expect, test } from "vitest";
import { OpenAiCompatibleAdapter } from "./openai-compatible-adapter";

const securityTool = {
  name: "security_scan",
  description: "bounded security runtime",
  inputSchema: { type: "object", required: ["tool", "target"], properties: { tool: { type: "string" }, target: { type: "string" } } }
};

test("forces only security_scan through the runtime JSON schema before readiness evidence exists", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const fetcher: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    const forced = body.json_schema !== undefined;
    return new Response(JSON.stringify({
      choices: [{ message: { content: forced ? JSON.stringify({ name: "security_scan", arguments: { tool: "dns_lookup", target: "127.0.0.1" } }) : "done" }, finish_reason: "stop" }],
      usage: {}
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const adapter = new OpenAiCompatibleAdapter("http://example.invalid/v1", "test", fetcher);
  const first = await adapter.generate({
    requestId: "readiness-force-1",
    alias: "general-prod",
    messages: [
      { role: "system", content: "SECURITY READINESS REQUIRED: execute the requested security operation." },
      { role: "user", content: "Run dns_lookup." }
    ],
    tools: [securityTool, { name: "current_time", description: "time", inputSchema: { type: "object" } }]
  });
  expect(bodies[0]?.tool_choice).toBeUndefined();
  expect(bodies[0]?.tools).toBeUndefined();
  expect(bodies[0]?.stream).toBe(false);
  expect(bodies[0]?.json_schema).toMatchObject({
    type: "object",
    additionalProperties: false,
    required: ["name", "arguments"],
    properties: {
      name: { type: "string", enum: ["security_scan"] },
      arguments: securityTool.inputSchema
    }
  });
  expect(first.finishReason).toBe("tool_call");
  expect(first.toolCalls).toEqual([{ id: "readiness-force-1:forced-tool", name: "security_scan", input: { tool: "dns_lookup", target: "127.0.0.1" } }]);
  expect(first.content).toBe("");

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
  expect(bodies[0]?.json_schema).toBeUndefined();
  expect(bodies[0]?.tool_choice).toBe("auto");
  expect(bodies[0]?.tools).toHaveLength(1);
});

test("does not force security_scan without the reserved readiness marker", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const fetcher: typeof fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ choices: [{ message: { content: "normal" }, finish_reason: "stop" }], usage: {} }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const adapter = new OpenAiCompatibleAdapter("http://example.invalid/v1", "test", fetcher);
  await adapter.generate({ requestId: "normal-lab", alias: "general-prod", messages: [{ role: "system", content: "Mode: lab." }, { role: "user", content: "Inspect the target." }], tools: [securityTool] });
  expect(bodies[0]?.json_schema).toBeUndefined();
  expect(bodies[0]?.tool_choice).toBe("auto");
});

test("fails closed when a forced schema response changes the tool name", async () => {
  const fetcher: typeof fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({ name: "mcp__builtin__web__WebFetch", arguments: { url: "https://example.com" } }) }, finish_reason: "stop" }]
  }), { status: 200, headers: { "content-type": "application/json" } });
  const adapter = new OpenAiCompatibleAdapter("http://example.invalid/v1", "test", fetcher);
  await expect(adapter.generate({
    requestId: "readiness-wrong-tool",
    alias: "general-prod",
    messages: [
      { role: "system", content: "SECURITY READINESS REQUIRED: execute the requested security operation." },
      { role: "user", content: "Run dns_lookup." }
    ],
    tools: [securityTool]
  })).rejects.toThrow("forced_tool_name_mismatch");
});
