import { describe, expect, it } from "vitest";
import type { GenerateRequest, ModelAdapter } from "@div3rsa/model-sdk";
import type { AgentToolRuntime } from "./contracts";
import { AgentOrchestrator, InMemoryRunRepository } from "./index";

describe("runtime diagnostic grounding", () => {
  it("tells the model to treat runtime telemetry as authoritative instead of guessing resource or model-size failures", async () => {
    const requests: GenerateRequest[] = [];
    const model: ModelAdapter = {
      async generate(request) {
        requests.push(request);
        return {
          modelVersionId: "test-model",
          content: "Runtime capabilities are available.",
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 }
        };
      },
      async *stream() { yield "ok"; },
      async estimateTokens() { return 1; },
      getCapabilities() { return new Set(["general", "tool_use"] as const); },
      async healthCheck() { return { ok: true, latencyMs: 1 }; }
    };
    const tools: AgentToolRuntime = {
      definitions: () => [{ name: "web_search", description: "Search the web", inputSchema: { type: "object" } }],
      capabilities: () => ({ httpRequests: true, dns: true, shell: true, curl: true, sandbox: true, networkEgress: true }),
      async execute() { return { ok: true }; }
    };

    const run = await new AgentOrchestrator({ model, runs: new InMemoryRunRepository(), tools }).run({
      requestId: "diagnostic-grounding",
      traceId: "diagnostic-grounding",
      conversationId: "diagnostic-grounding",
      mode: "chat",
      prompt: "Can you use the available tools?",
      actor: {
        userId: "user-1",
        organizationId: "org-1",
        workspaceId: "ws-1",
        permissions: new Set(["agent.run"]),
        assuranceLevel: "aal1"
      }
    });

    expect(run.status).toBe("completed");
    const system = requests[0]?.messages.find((message) => message.role === "system")?.content ?? "";
    expect(system).toContain("Runtime capability facts above are authoritative for this run");
    expect(system).toContain("Do not claim that the model is too small");
    expect(system).toContain("tool support is outdated unless an explicit runtime error or telemetry");
    expect(system).toContain("A missing or failed tool call is a protocol/execution failure");
    expect(system).toContain("Available structured tools: web_search");
    expect(system).toContain('"networkEgress":true');
  });
});
