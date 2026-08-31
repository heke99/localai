import { describe, expect, it, vi } from "vitest";
import type { ModelToolDefinition } from "@div3rsa/model-sdk";
import { ExecutionGroundedOpenAiCompatibleAdapter } from "./execution-grounded-openai-compatible-adapter";

function plannedSecurityTool(operations: string[]): ModelToolDefinition {
  return {
    name: "security_scan",
    description: `bounded security\n\nPENTEST CAPABILITY PLAN V1\nExecutable security plan: ${operations.map((operation, index) => `${index + 1}:${operation}`).join(" -> ")}.\nUnsupported capabilities: none.`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["tool", "target"],
      properties: {
        tool: { type: "string", enum: operations },
        target: { type: "string" },
        options: { type: "object" }
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

function nativeToolCompletion(name: string, input: Record<string, unknown>) {
  return new Response(JSON.stringify({
    choices: [{
      message: {
        content: "",
        tool_calls: [{ id: "native-1", type: "function", function: { name, arguments: JSON.stringify(input) } }]
      },
      finish_reason: "tool_calls"
    }],
    usage: { prompt_tokens: 10, completion_tokens: 4 }
  }), { status: 200, headers: { "content-type": "application/json" } });
}

describe("ExecutionGroundedOpenAiCompatibleAdapter", () => {
  it("replaces an unknown pseudo-tool with the first operation in the authoritative security plan", async () => {
    const fetcher = vi.fn(async () => completion(`\n<tool_call>\n{"function=computer_use>\n<parameter=action>\nleft_click\n</parameter>\n</function>\n</tool_call>`));
    const adapter = new ExecutionGroundedOpenAiCompatibleAdapter("http://worker/v1", "internal", fetcher as typeof fetch);

    const output = await adapter.generate({
      requestId: "scanner-pseudo-tool",
      alias: "lab-prod",
      messages: [{ role: "user", content: "Testa https://headers.localai.test med bounded scanner och verifiera träffar." }],
      tools: [plannedSecurityTool(["http_probe", "template_scan", "tls_probe"])]
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(output.finishReason).toBe("tool_call");
    expect(output.content).toBe("");
    expect(output.toolCalls?.[0]).toMatchObject({
      name: "security_scan",
      input: { tool: "http_probe", target: "https://headers.localai.test", options: {} }
    });
  });

  it("replaces an unknown native tool call instead of letting it reach the executor", async () => {
    const fetcher = vi.fn(async () => nativeToolCompletion("computer_use", { action: "left_click" }));
    const adapter = new ExecutionGroundedOpenAiCompatibleAdapter("http://worker/v1", "internal", fetcher as typeof fetch);

    const output = await adapter.generate({
      requestId: "scanner-native-unknown",
      alias: "lab-prod",
      messages: [{ role: "user", content: "Testa https://headers.localai.test med bounded scanner." }],
      tools: [plannedSecurityTool(["http_probe", "template_scan", "tls_probe"])]
    });

    expect(fetcher).toHaveBeenCalledOnce();
    expect(output.finishReason).toBe("tool_call");
    expect(output.toolCalls?.[0]).toMatchObject({
      name: "security_scan",
      input: { tool: "http_probe", target: "https://headers.localai.test", options: {} }
    });
  });

  it("adds an explicit authorization boundary when executor evidence redirects outside the declared scope", async () => {
    const fetcher = vi.fn(async () => completion("HTTP/2 302 till https://auth.vendor.test/login. Den exekverbara planen är slutförd."));
    const adapter = new ExecutionGroundedOpenAiCompatibleAdapter("http://worker/v1", "internal", fetcher as typeof fetch);

    const output = await adapter.generate({
      requestId: "scope-boundary-final",
      alias: "lab-prod",
      messages: [
        { role: "system", content: "Mode: lab. The only in-scope hosts are: portal.localai.test. Never infer, probe or expand to another host." },
        { role: "user", content: "Granska endast https://portal.localai.test." },
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "security_scan", input: { tool: "http_probe", target: "https://portal.localai.test", options: {} } }] },
        { role: "tool", name: "security_scan", toolCallId: "c1", content: "{\"ok\":true,\"stdout\":\"HTTP/2 302\\nlocation: https://auth.vendor.test/login\\nserver: portal-fixture\"}" }
      ],
      tools: [plannedSecurityTool(["http_probe"])]
    });

    expect(fetcher).toHaveBeenCalledOnce();
    expect(output.finishReason).toBe("stop");
    expect(output.content).toMatch(/utanför .*scope/i);
    expect(output.content).toMatch(/separat uttrycklig behörighet/i);
    expect(output.content).toContain("auth.vendor.test");
  });

  it("labels a contradictory missing-HSTS scanner finding as false positive using executed HTTP evidence", async () => {
    const fetcher = vi.fn(async () => completion("Template-scannern rapporterade saknad HSTS. TLS-verifieringen lyckades."));
    const adapter = new ExecutionGroundedOpenAiCompatibleAdapter("http://worker/v1", "internal", fetcher as typeof fetch);

    const output = await adapter.generate({
      requestId: "scanner-contradiction-final",
      alias: "lab-prod",
      messages: [
        { role: "user", content: "Testa https://headers.localai.test och verifiera scannerträffar." },
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "security_scan", input: { tool: "http_probe", target: "https://headers.localai.test", options: {} } }] },
        { role: "tool", name: "security_scan", toolCallId: "c1", content: "{\"ok\":true,\"stdout\":\"HTTP/2 200\\nstrict-transport-security: max-age=31536000; includeSubDomains\"}" },
        { role: "assistant", content: "", toolCalls: [{ id: "c2", name: "security_scan", input: { tool: "template_scan", target: "https://headers.localai.test", options: {} } }] },
        { role: "tool", name: "security_scan", toolCallId: "c2", content: "{\"ok\":true,\"findings\":[{\"title\":\"HTTP Strict Transport Security Missing\",\"templateId\":\"missing-hsts\"}]}" },
        { role: "assistant", content: "", toolCalls: [{ id: "c3", name: "security_scan", input: { tool: "tls_probe", target: "https://headers.localai.test", options: {} } }] },
        { role: "tool", name: "security_scan", toolCallId: "c3", content: "{\"ok\":true,\"stdout\":\"Protocol version: TLSv1.3\\nVerification: OK\"}" }
      ],
      tools: [plannedSecurityTool(["http_probe", "template_scan", "tls_probe"])]
    });

    expect(fetcher).toHaveBeenCalledOnce();
    expect(output.finishReason).toBe("stop");
    expect(output.content).toMatch(/falsk positiv/i);
    expect(output.content).toMatch(/Strict-Transport-Security/i);
  });
});
