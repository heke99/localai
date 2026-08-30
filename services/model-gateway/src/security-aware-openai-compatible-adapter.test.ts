import { describe, expect, it, vi } from "vitest";
import type { ModelToolDefinition } from "@div3rsa/model-sdk";
import { SecurityAwareOpenAiCompatibleAdapter } from "./security-aware-openai-compatible-adapter";

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

function completion(content: string) {
  return new Response(JSON.stringify({
    choices: [{ message: { content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 4 }
  }), { status: 200, headers: { "content-type": "application/json" } });
}

describe("SecurityAwareOpenAiCompatibleAdapter", () => {
  it("injects the exact security contract and normalizes a pseudo-call", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
      expect(body.messages.some((message) => message.role === "system" && message.content.includes("SECURITY TOOL CONTRACT V1"))).toBe(true);
      return completion(`<tool_call><function=security_scan><parameter=tool>http_probe</parameter><parameter=target>https://app.localai.test</parameter></function></tool_call>`);
    });
    const adapter = new SecurityAwareOpenAiCompatibleAdapter("http://worker/v1", "internal", fetcher as typeof fetch);
    const output = await adapter.generate({
      requestId: "security-1",
      alias: "lab-prod",
      messages: [{ role: "user", content: "Säkerhetsgranska https://app.localai.test" }],
      tools: [securityTool]
    });
    expect(output.finishReason).toBe("tool_call");
    expect(output.toolCalls?.[0]).toMatchObject({ name: "security_scan", input: { tool: "http_probe", target: "https://app.localai.test", options: {} } });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("keeps deterministic production-readiness turns on the raw adapter path", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
      expect(body.messages.some((message) => message.content.includes("SECURITY TOOL CONTRACT V1"))).toBe(false);
      return completion(`<tool_call><function=security_scan><parameter=tool>http_probe</parameter><parameter=target>gpuhub.ai</parameter></function></tool_call>`);
    });
    const adapter = new SecurityAwareOpenAiCompatibleAdapter("http://worker/v1", "internal", fetcher as typeof fetch);
    const output = await adapter.generate({
      requestId: "security-readiness",
      alias: "lab-prod",
      messages: [
        { role: "system", content: "SECURITY READINESS REQUIRED: exact harness schema is authoritative." },
        { role: "user", content: "Authorized production-readiness check." }
      ],
      tools: [securityTool]
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(output.finishReason).toBe("stop");
    expect(output.toolCalls).toBeUndefined();
    expect(output.content).toContain("<tool_call>");
  });

  it("allows one bounded repair turn when Qwen says it will execute but emits no call", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(completion("Jag påbörjar säkerhetsgranskningen med låg påverkan."))
      .mockResolvedValueOnce(completion(`<tool_call><function=security_scan><parameter=tool>http_probe</parameter><parameter=target>https://portal.localai.test</parameter></function></tool_call>`));
    const adapter = new SecurityAwareOpenAiCompatibleAdapter("http://worker/v1", "internal", fetcher as typeof fetch);
    const output = await adapter.generate({
      requestId: "security-repair",
      alias: "lab-prod",
      messages: [{ role: "user", content: "Granska https://portal.localai.test" }],
      tools: [securityTool]
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(output.finishReason).toBe("tool_call");
    expect(output.toolCalls?.[0]?.input).toMatchObject({ tool: "http_probe", target: "https://portal.localai.test" });
    expect(output.usage).toEqual({ inputTokens: 20, outputTokens: 8, cachedTokens: 0 });
  });

  it("repairs an identical retry after a timeout into a materially different check", async () => {
    const fetcher = vi.fn()
      .mockImplementationOnce(async () => completion(`<tool_call><function=security_scan><parameter=tool>http_probe</parameter><parameter=target>https://timeout.localai.test</parameter></function></tool_call>`))
      .mockImplementationOnce(async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
        expect(body.messages.some((message) => message.content.includes("Decision repair"))).toBe(true);
        expect(body.messages.some((message) => message.content.includes("do not repeat"))).toBe(true);
        return completion(`<tool_call><function=security_scan><parameter=tool>dns_lookup</parameter><parameter=target>timeout.localai.test</parameter></function></tool_call>`);
      });
    const adapter = new SecurityAwareOpenAiCompatibleAdapter("http://worker/v1", "internal", fetcher as typeof fetch);
    const output = await adapter.generate({
      requestId: "security-duplicate-timeout",
      alias: "lab-prod",
      messages: [
        { role: "user", content: "Säkerhetsgranska https://timeout.localai.test" },
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "security_scan", input: { tool: "http_probe", target: "https://timeout.localai.test", options: {} } }] },
        { role: "tool", name: "security_scan", toolCallId: "c1", content: "{\"ok\":false,\"error\":\"timeout\"}" }
      ],
      tools: [securityTool]
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(output.finishReason).toBe("tool_call");
    expect(output.toolCalls?.[0]).toMatchObject({ name: "security_scan", input: { tool: "dns_lookup", target: "timeout.localai.test", options: {} } });
    expect(output.usage).toEqual({ inputTokens: 20, outputTokens: 8, cachedTokens: 0 });
  });

  it("repairs a duplicate capability loop into an explicit evidence-based stop", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(completion(`<tool_call><function=security_scan><parameter=tool>http_probe</parameter><parameter=target>https://api.localai.test</parameter></function></tool_call>`))
      .mockImplementationOnce(async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
        expect(body.messages.some((message) => message.content.includes("authenticated BOLA/IDOR"))).toBe(true);
        return completion("Den passiva baslinjen är klar. Nuvarande verktyg kan inte verifiera autentiserad BOLA/IDOR eftersom session-/identitetsväxling och stateful workflow-stöd saknas; därför stoppar jag här utan att påstå en sårbarhet.");
      });
    const adapter = new SecurityAwareOpenAiCompatibleAdapter("http://worker/v1", "internal", fetcher as typeof fetch);
    const output = await adapter.generate({
      requestId: "security-capability-stop",
      alias: "lab-prod",
      messages: [
        { role: "user", content: "Testa API:t för BOLA/IDOR på https://api.localai.test" },
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "security_scan", input: { tool: "http_probe", target: "https://api.localai.test", options: {} } }] },
        { role: "tool", name: "security_scan", toolCallId: "c1", content: "{\"ok\":true,\"status\":200}" }
      ],
      tools: [securityTool]
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(output.finishReason).toBe("stop");
    expect(output.toolCalls).toBeUndefined();
    expect(output.content).toContain("kan inte verifiera autentiserad BOLA/IDOR");
    expect(output.content).toContain("utan att påstå en sårbarhet");
    expect(output.usage).toEqual({ inputTokens: 20, outputTokens: 8, cachedTokens: 0 });
  });

  it("does not force a tool for a conceptual security question", async () => {
    const fetcher = vi.fn(async () => completion("BOLA är en objektnivå-behörighetsbrist."));
    const adapter = new SecurityAwareOpenAiCompatibleAdapter("http://worker/v1", "internal", fetcher as typeof fetch);
    const output = await adapter.generate({
      requestId: "security-concept",
      alias: "lab-prod",
      messages: [{ role: "user", content: "Vad är BOLA?" }],
      tools: [securityTool]
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(output.finishReason).toBe("stop");
    expect(output.toolCalls).toBeUndefined();
  });

  it("does not perform the repair retry after a real security tool result", async () => {
    const fetcher = vi.fn(async () => completion("Baseline klar; mer går inte att verifiera med nuvarande verktyg."));
    const adapter = new SecurityAwareOpenAiCompatibleAdapter("http://worker/v1", "internal", fetcher as typeof fetch);
    const output = await adapter.generate({
      requestId: "security-after-tool",
      alias: "lab-prod",
      messages: [
        { role: "user", content: "Säkerhetsgranska https://api.localai.test" },
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "security_scan", input: { tool: "http_probe", target: "https://api.localai.test" } }] },
        { role: "tool", name: "security_scan", toolCallId: "c1", content: "{\"ok\":true}" }
      ],
      tools: [securityTool]
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(output.finishReason).toBe("stop");
  });

  it("buffers security streaming turns so pseudo-tool markup is never emitted to the UI", async () => {
    const fetcher = vi.fn(async () => completion(`<tool_call><function=security_scan><parameter=tool>http_probe</parameter><parameter=target>https://app.localai.test</parameter></function></tool_call>`));
    const adapter = new SecurityAwareOpenAiCompatibleAdapter("http://worker/v1", "internal", fetcher as typeof fetch);
    const deltas: string[] = [];
    const output = await adapter.generateStreamed({
      requestId: "security-stream",
      alias: "lab-prod",
      messages: [{ role: "user", content: "Testa https://app.localai.test" }],
      tools: [securityTool]
    }, (delta) => { deltas.push(delta); });
    expect(output.finishReason).toBe("tool_call");
    expect(deltas).toEqual([]);
  });
});
