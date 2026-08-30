import { describe, expect, it } from "vitest";
import type { GenerateResult, ModelToolDefinition } from "@div3rsa/model-sdk";
import { normalizeTextualToolResult } from "./textual-tool-call-normalizer";

const securityTool: ModelToolDefinition = {
  name: "security_scan",
  description: "bounded security",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["tool", "target"],
    properties: {
      tool: { type: "string", enum: ["dns_lookup", "http_probe", "tls_probe", "port_scan", "template_scan", "content_discovery"] },
      target: { type: "string" },
      options: {
        type: "object",
        additionalProperties: false,
        properties: {
          ports: { type: "array", items: { type: "integer" } },
          maxRate: { type: "integer" },
          rateLimit: { type: "integer" }
        }
      }
    }
  }
};

function result(content: string): GenerateResult {
  return {
    modelVersionId: "qwen-test",
    content,
    finishReason: "stop",
    usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 }
  };
}

describe("textual security tool option normalization", () => {
  it("accepts only the options belonging to the selected security operation", () => {
    const normalized = normalizeTextualToolResult(result(
      '<tool_call>{"tool":"security_scan","target":"example.test","scan_type":"port_scan","options":{"ports":[80,443],"maxRate":100}}</tool_call>'
    ), [securityTool]);

    expect(normalized.normalized).toBe(true);
    expect(normalized.result.toolCalls?.[0]).toMatchObject({
      name: "security_scan",
      input: { tool: "port_scan", target: "example.test", options: { ports: [80, 443], maxRate: 100 } }
    });
  });

  it("rejects irrelevant options instead of forwarding them to a passive probe", () => {
    const normalized = normalizeTextualToolResult(result(
      '<tool_call>{"tool":"http_probe","target":"example.test","options":{"rateLimit":10}}</tool_call>'
    ), [securityTool]);

    expect(normalized.normalized).toBe(false);
    expect(normalized.result.finishReason).toBe("stop");
    expect(normalized.result.toolCalls).toBeUndefined();
  });

  it("rejects unknown options instead of silently accepting invented executor arguments", () => {
    const normalized = normalizeTextualToolResult(result(
      '<tool_call>{"tool":"port_scan","target":"example.test","options":{"depth":5,"maxRate":100}}</tool_call>'
    ), [securityTool]);

    expect(normalized.normalized).toBe(false);
  });

  it("rejects out-of-range bounded values", () => {
    const normalized = normalizeTextualToolResult(result(
      '<tool_call>{"tool":"content_discovery","target":"example.test","options":{"rateLimit":5000}}</tool_call>'
    ), [securityTool]);

    expect(normalized.normalized).toBe(false);
  });
});
