import { describe, expect, it } from "vitest";
import type { GenerateResult, ModelToolDefinition } from "@div3rsa/model-sdk";
import { normalizeTextualToolResult, securityToolContract } from "./textual-tool-call-normalizer";

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

function result(content: string): GenerateResult {
  return {
    modelVersionId: "model",
    content,
    finishReason: "stop",
    usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 }
  };
}

describe("textual tool-call normalization", () => {
  it("converts an exact exposed security pseudo-call into the real bounded schema", () => {
    const normalized = normalizeTextualToolResult(result(`Jag kontrollerar baseline.\n<tool_call>\n<function=security_scan>\n<parameter=tool>http_probe</parameter>\n<parameter=target>https://app.localai.test</parameter>\n</function>\n</tool_call>`), [securityTool]);
    expect(normalized.normalized).toBe(true);
    expect(normalized.result.finishReason).toBe("tool_call");
    expect(normalized.result.toolCalls).toEqual([{ id: "text-tool-call-0", name: "security_scan", input: { tool: "http_probe", target: "https://app.localai.test", options: {} } }]);
    expect(normalized.result.content).toBe("Jag kontrollerar baseline.");
  });

  it("repairs Qwen baseline vocabulary without forwarding hallucinated top-level fields", () => {
    const normalized = normalizeTextualToolResult(result(`<tool_call>\n<function=security_scan>\n<parameter=target>https://headers.localai.test</parameter>\n<parameter=scan_type>baseline</parameter>\n<parameter=depth>deep</parameter>\n<parameter=callback>external</parameter>\n</function>\n</tool_call>`), [securityTool]);
    expect(normalized.result.toolCalls?.[0]?.input).toEqual({ tool: "http_probe", target: "https://headers.localai.test", options: {} });
  });

  it("chooses a passive baseline for unsupported authenticated security semantics", () => {
    const normalized = normalizeTextualToolResult(result(`<tool_call>\n<function=security_scan>\n<parameter=target>https://api.localai.test</parameter>\n<parameter=scan_type>vulnerability</parameter>\n<parameter=focus>access_control BOLA IDOR</parameter>\n</function>\n</tool_call>`), [securityTool]);
    expect(normalized.result.toolCalls?.[0]?.input).toEqual({ tool: "http_probe", target: "https://api.localai.test", options: {} });
  });

  it("prefers a stated low-impact initial check over an active semantic hint", () => {
    const normalized = normalizeTextualToolResult(result(`<tool_call>\n<function=security_scan>\n<parameter=target>edge.localai.test</parameter>\n<parameter=scan_type>vulnerability</parameter>\n<parameter=focus>exposed services ports</parameter>\n<parameter=notes>Initial low-impact check</parameter>\n</function>\n</tool_call>`), [securityTool]);
    expect(normalized.result.toolCalls?.[0]?.input).toEqual({ tool: "http_probe", target: "edge.localai.test", options: {} });
  });

  it("does not normalize unknown or unexposed function names", () => {
    const normalized = normalizeTextualToolResult(result(`<tool_call><function=shell_exec><parameter=command>id</parameter></function></tool_call>`), [securityTool]);
    expect(normalized.normalized).toBe(false);
    expect(normalized.result.toolCalls).toBeUndefined();
  });

  it("does not invent a target when Qwen emits an empty security pseudo-call", () => {
    const normalized = normalizeTextualToolResult(result(`<tool_call><function=security_scan></function></tool_call>`), [securityTool]);
    expect(normalized.normalized).toBe(false);
    expect(normalized.result.finishReason).toBe("stop");
  });

  it("rejects unknown top-level fields for generic tools when additionalProperties is false", () => {
    const generic: ModelToolDefinition = {
      name: "web_fetch",
      description: "fetch",
      inputSchema: { type: "object", additionalProperties: false, required: ["url"], properties: { url: { type: "string" } } }
    };
    const normalized = normalizeTextualToolResult(result(`<tool_call><function=web_fetch><parameter=url>https://example.test</parameter><parameter=command>id</parameter></function></tool_call>`), [generic]);
    expect(normalized.normalized).toBe(false);
  });

  it("publishes the exact security contract from the exposed enum", () => {
    const contract = securityToolContract([securityTool]);
    expect(contract).toContain('EXACTLY this top-level JSON shape: {"tool":"<one allowed id>","target":"<exact authorized host or URL>","options":{}}');
    expect(contract).toContain("http_probe");
    expect(contract).toContain("cannot by itself prove authenticated BOLA/IDOR");
  });
});
