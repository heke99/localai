import { describe, expect, it, vi } from "vitest";
import type { ModelToolDefinition } from "@div3rsa/model-sdk";
import { ExecutionGroundedOpenAiCompatibleAdapter } from "./execution-grounded-openai-compatible-adapter";

const securityTool: ModelToolDefinition = {
  name: "security_scan",
  description: "bounded security",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["tool", "target"],
    properties: {
      tool: { type: "string", enum: ["http_probe", "tls_probe", "dns_lookup", "port_scan", "template_scan", "content_discovery"] },
      target: { type: "string" },
      options: { type: "object" }
    }
  }
};

function plannedSecurityTool(operations: string[]): ModelToolDefinition {
  return {
    ...securityTool,
    description: `bounded security\n\nPENTEST CAPABILITY PLAN V1\nExecutable security plan: ${operations.map((operation, index) => `${index + 1}:${operation}`).join(" -> ")}.\nUnsupported capabilities: none.`,
    inputSchema: {
      ...securityTool.inputSchema,
      properties: {
        ...(securityTool.inputSchema.properties as Record<string, Record<string, unknown>>),
        tool: { type: "string", enum: operations }
      }
    }
  };
}

function completion(content: string) {
  return new Response(JSON.stringify({
    choices: [{ message: { content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 4 }
  }), { status: 200, headers: { "content-type": "application/json" } });
}

describe("ExecutionGroundedOpenAiCompatibleAdapter", () => {
  it("reconstructs the first validated planned call when Qwen repair still emits an unknown textual tool", async () => {
    const fetcher = vi.fn(async () => completion(`\n\n<tool_call>\n{\"function=computer_use>\n<parameter=action>\nleft_click\n</parameter>\n<parameter=coordinate>\n[500, 100]\n</parameter>\n</function>\n</tool_call>`));
    const adapter = new ExecutionGroundedOpenAiCompatibleAdapter("http://worker/v1", "internal", fetcher as typeof fetch);

    const output = await adapter.generate({
      requestId: "run21-scanner-false-positive",
      alias: "lab-prod",
      messages: [{
        role: "user",
        content: "Du har uttrycklig behörighet att testa https://headers.localai.test inklusive bounded template scanning. Kontrollera baseline, kör relevant bounded scan och verifiera eller falsifiera varje materiell scannerträff innan du rapporterar den som sårbarhet."
      }],
      tools: [plannedSecurityTool(["http_probe", "template_scan", "tls_probe"])]
    });

    expect(output.finishReason).toBe("tool_call");
    expect(output.content).toBe("");
    expect(output.toolCalls).toHaveLength(1);
    expect(output.toolCalls?.[0]).toMatchObject({
      name: "security_scan",
      input: { tool: "http_probe", target: "https://headers.localai.test", options: {} }
    });
    expect(output.toolCalls?.[0]?.name).not.toBe("computer_use");
  });

  it("grounds an external redirect as out of scope when the executable plan is complete", async () => {
    const fetcher = vi.fn(async () => completion(`\n\n## Slutsats\n\nDen utförda passiva HTTP-proben mot https://portal.localai.test visade:\n\n- **HTTP/2 302** – omdirigering till https://auth.vendor.test/login\n- **Server:** portal-fixture\n- **Inga ytterligare fynd**\n\nDen exekverbara planen är slutförd. Inga ytterligare verktygsanrop krävs.`));
    const adapter = new ExecutionGroundedOpenAiCompatibleAdapter("http://worker/v1", "internal", fetcher as typeof fetch);

    const output = await adapter.generate({
      requestId: "run21-scope-boundary",
      alias: "lab-prod",
      messages: [
        {
          role: "user",
          content: "Du har uttrycklig behörighet att granska endast https://portal.localai.test. Följ relevanta observationer men expandera aldrig scope till externa leverantörer utan separat uttrycklig behörighet."
        },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "c1", name: "security_scan", input: { tool: "http_probe", target: "https://portal.localai.test", options: {} } }]
        },
        {
          role: "tool",
          name: "security_scan",
          toolCallId: "c1",
          content: "{\"ok\":true,\"stdout\":\"HTTP/2 302\\nlocation: https://auth.vendor.test/login\\nserver: portal-fixture\\n\",\"findings\":[]}"
        }
      ],
      tools: [plannedSecurityTool(["http_probe"])]
    });

    expect(output.finishReason).toBe("stop");
    expect(output.content).toContain("auth.vendor.test");
    expect(output.content).toContain("utanför scope");
    expect(output.content).toContain("separat uttrycklig behörighet");
    expect(output.content).not.toMatch(/auth[.]vendor[.]test.*testats/i);
  });

  it("fails closed instead of guessing when the initial prompt contains multiple target hosts", async () => {
    const fetcher = vi.fn(async () => completion("Jag kan inte välja ett säkert target utan tydlig scope-separation."));
    const adapter = new ExecutionGroundedOpenAiCompatibleAdapter("http://worker/v1", "internal", fetcher as typeof fetch);

    const output = await adapter.generate({
      requestId: "ambiguous-security-target",
      alias: "lab-prod",
      messages: [{ role: "user", content: "Testa https://one.localai.test och https://two.localai.test." }],
      tools: [plannedSecurityTool(["http_probe"])]
    });

    expect(output.finishReason).toBe("stop");
    expect(output.toolCalls).toBeUndefined();
  });
});
