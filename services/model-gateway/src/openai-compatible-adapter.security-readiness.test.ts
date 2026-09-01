import { expect, test } from "vitest";
import { OpenAiCompatibleAdapter } from "./openai-compatible-adapter";

const securityTool = {
  name: "security_scan",
  description: "bounded security runtime",
  inputSchema: { type: "object", required: ["tool", "target"], properties: { tool: { type: "string" }, target: { type: "string" } } }
};
const currentTimeTool = {
  name: "current_time",
  description: "deterministic current time",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["timezone"],
    properties: { timezone: { type: "string", enum: ["Europe/Stockholm"] } }
  }
};

test("keeps security readiness on the dedicated raw bridge path", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const fetcher: typeof fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ choices: [{ message: { content: "<tool_call>raw readiness bridge</tool_call>" }, finish_reason: "stop" }], usage: {} }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const adapter = new OpenAiCompatibleAdapter("http://example.invalid/v1", "test", fetcher);
  const result = await adapter.generate({
    requestId: "readiness-raw-1",
    alias: "general-prod",
    messages: [
      { role: "system", content: "SECURITY READINESS REQUIRED: exact harness schema is authoritative." },
      { role: "user", content: "Authorized production-readiness check." }
    ],
    tools: [securityTool]
  });
  expect(bodies[0]?.json_schema).toBeUndefined();
  expect(bodies[0]?.tool_choice).toBe("auto");
  expect(bodies[0]?.tools).toHaveLength(1);
  expect(result.finishReason).toBe("stop");
  expect(result.content).toContain("raw readiness bridge");
});

test("does not force security_scan for normal lab prompts", async () => {
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

test("fails closed when a deterministic live-tool schema response changes the tool name", async () => {
  const fetcher: typeof fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({ name: "mcp__builtin__web__WebFetch", arguments: { url: "https://example.com" } }) }, finish_reason: "stop" }]
  }), { status: 200, headers: { "content-type": "application/json" } });
  const adapter = new OpenAiCompatibleAdapter("http://example.invalid/v1", "test", fetcher);
  await expect(adapter.generate({
    requestId: "live-wrong-tool",
    alias: "general-prod",
    messages: [
      { role: "system", content: "Task risk: low. Reasoning policy: FAST. LIVE INFORMATION REQUIRED: use an available deterministic/live tool. Research depth: fast." },
      { role: "user", content: "Vad är klockan i Stockholm just nu?" }
    ],
    tools: [currentTimeTool]
  })).rejects.toThrow("forced_tool_name_mismatch");
});
