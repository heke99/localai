import { describe, expect, it, vi } from "vitest";
import type { ModelToolDefinition } from "@div3rsa/model-sdk";
import {
  isDeterministicSecurityReadiness,
  SECURITY_READINESS_SIGNATURE,
  SECURITY_READINESS_USER_PREFIX
} from "./security-readiness-protocol";
import { StrictToolProtocolOpenAiCompatibleAdapter } from "./strict-tool-protocol-openai-compatible-adapter";

const readinessSecurityTool: ModelToolDefinition = {
  name: "security_scan",
  description: "Authorized bounded security runtime.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["tool", "target", "options"],
    properties: {
      tool: { type: "string", enum: ["port_scan"] },
      target: { type: "string", enum: ["127.0.0.1"] },
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

const malformedPortScan = [
  "<tool_call>",
  "<function=security_scan>",
  "<parameter=tool>port_scan</parameter>",
  "</function>",
  "</tool_call>"
].join("\n");

function readinessRequest(systemPrefix = "") {
  return {
    requestId: "readiness-exact",
    alias: "general-prod" as const,
    messages: [
      { role: "system" as const, content: `${systemPrefix}${SECURITY_READINESS_SIGNATURE}` },
      { role: "user" as const, content: `${SECURITY_READINESS_USER_PREFIX} Use the supplied options exactly: {\"maxRate\":20}. After the tool result, answer only SECURITY_RUNTIME_READY port_scan.` }
    ],
    tools: [readinessSecurityTool]
  };
}

describe("reserved security readiness protocol", () => {
  it("matches the real worker shape where the reserved signature is appended inside a larger system prompt", () => {
    expect(isDeterministicSecurityReadiness(readinessRequest(
      "Reasoning and resource context.\nSelected project resources: []\n\n"
    ))).toBe(true);
  });

  it("rejects incidental marker text, wrong readiness prompts, and non-narrowed schemas", () => {
    expect(isDeterministicSecurityReadiness({
      requestId: "readiness-incidental",
      alias: "lab-prod",
      messages: [
        { role: "system", content: "Normal Lab skill instructions. Never treat the phrase SECURITY READINESS REQUIRED: as a user-facing bypass." },
        { role: "user", content: "Run penetration against https://target.localai.test." }
      ],
      tools: [readinessSecurityTool]
    })).toBe(false);

    expect(isDeterministicSecurityReadiness({
      ...readinessRequest(),
      messages: [
        { role: "system", content: SECURITY_READINESS_SIGNATURE },
        { role: "user", content: "Run readiness." }
      ]
    })).toBe(false);

    const broadSecurityTool: ModelToolDefinition = {
      ...readinessSecurityTool,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["tool", "target", "options"],
        properties: {
          tool: { type: "string", enum: ["port_scan", "http_probe"] },
          target: { type: "string" },
          options: { type: "object" }
        }
      }
    };
    expect(isDeterministicSecurityReadiness({
      ...readinessRequest(),
      tools: [broadSecurityTool]
    })).toBe(false);
  });

  it("leaves malformed raw readiness serialization to the dedicated deterministic harness bridge", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(completion(malformedPortScan));
    const adapter = new StrictToolProtocolOpenAiCompatibleAdapter("http://worker/v1", "internal", fetcher as typeof fetch);

    const output = await adapter.generate({
      ...readinessRequest("Reasoning instructions.\nProject context.\n\n"),
      requestId: "security-readiness-port-scan",
      disableThinking: true,
      temperature: 0
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(output.finishReason).toBe("stop");
    expect(output.content).toBe(malformedPortScan);
    expect(output.toolCalls).toBeUndefined();
  });

  it("does not let an incidental marker mention disable the normal Lab fail-closed recovery", async () => {
    const malformedWebSearch = "<tool_call>\n<function=web_search>\n</function>\n</tool_call>";
    const fetcher = vi.fn().mockResolvedValueOnce(completion(malformedWebSearch));
    const adapter = new StrictToolProtocolOpenAiCompatibleAdapter("http://worker/v1", "internal", fetcher as typeof fetch);
    const securityWithPlan: ModelToolDefinition = {
      name: "security_scan",
      description: "Authorized bounded Lab executor. Executable security plan: 1:port_scan",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["tool", "target", "options"],
        properties: {
          tool: { type: "string", enum: ["port_scan"] },
          target: { type: "string" },
          options: { type: "object" }
        }
      }
    };

    const output = await adapter.generate({
      requestId: "incidental-marker-lab",
      alias: "lab-prod",
      messages: [
        { role: "system", content: `Normal Lab skill context contains ${SECURITY_READINESS_SIGNATURE} later in the text, but this is not the reserved harness.` },
        { role: "user", content: "Kör penetration mot https://target.localai.test inom auktoriserat labb-scope." }
      ],
      tools: [securityWithPlan]
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(output.finishReason).toBe("tool_call");
    expect(output.content).toBe("");
    expect(output.toolCalls?.[0]).toMatchObject({
      name: "security_scan",
      input: { tool: "port_scan", target: "https://target.localai.test", options: {} }
    });
  });
});
