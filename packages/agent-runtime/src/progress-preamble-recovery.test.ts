import { describe, expect, it } from "vitest";
import type { GenerateRequest, GenerateResult, ModelAdapter } from "@div3rsa/model-sdk";
import type { AgentToolRuntime } from "./contracts";
import { AgentOrchestrator, InMemoryRunRepository } from "./index";

function scriptedModel(results: GenerateResult[], requests: GenerateRequest[]): ModelAdapter {
  return {
    async generate(request: GenerateRequest) {
      requests.push(request);
      const next = results.shift();
      if (!next) throw new Error("unexpected_model_call");
      return next;
    },
    async *stream() { yield "ok"; },
    async estimateTokens() { return 1; },
    getCapabilities() { return new Set(["general", "tool_use"] as const); },
    async healthCheck() { return { ok: true, latencyMs: 1 }; }
  };
}

function result(content: string, finishReason: GenerateResult["finishReason"], toolCalls?: GenerateResult["toolCalls"]): GenerateResult {
  return { modelVersionId: "test-model", content, finishReason, toolCalls, usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 } };
}

describe("progress preamble recovery", () => {
  it("keeps running when Qwen stops after a planning preamble and gives it a second structured-tool recovery chance", async () => {
    const requests: GenerateRequest[] = [];
    const calls: string[] = [];
    const tools: AgentToolRuntime = {
      definitions: () => [{ name: "web_search", description: "Search the web", inputSchema: { type: "object" } }],
      capabilities: () => ({ httpRequests: true, networkEgress: true, sandbox: true }),
      async execute(call) {
        calls.push(call.name);
        return { ok: true, output: { items: [{ title: "verified" }] } };
      }
    };
    const model = scriptedModel([
      result("Jag startar med att ladda relevanta färdigheter och kartlägga målet.", "stop"),
      result("Jag ska använda web_search för att kontrollera detta live.", "stop"),
      result("", "tool_call", [{ id: "call-search", name: "web_search", input: { query: "latest status" } }]),
      result("Kontrollen är genomförd och resultatet är verifierat.", "stop")
    ], requests);
    const runs = new InMemoryRunRepository();

    const run = await new AgentOrchestrator({ model, runs, tools }).run({
      requestId: "req-progress",
      traceId: "trace-progress",
      conversationId: "conversation-progress",
      mode: "chat",
      prompt: "Kontrollera status live och ge mig resultatet.",
      actor: {
        userId: "user-1",
        organizationId: "org-1",
        workspaceId: "ws-1",
        permissions: new Set(["agent.run"]),
        assuranceLevel: "aal1"
      }
    });

    expect(run.status).toBe("completed");
    expect(run.attempts).toBe(4);
    expect(calls).toEqual(["web_search"]);
    expect(run.steps.filter((step) => step.status === "retrying")).toHaveLength(2);
    expect(requests[1]?.messages.some((message) => message.role === "system" && message.content.includes("Do not stop at narration"))).toBe(true);
    expect(requests[2]?.requiredToolName).toBe("web_search");
  });
});
