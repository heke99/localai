import { describe, expect, it } from "vitest";
import type { GenerateRequest, GenerateResult, ModelAdapter } from "@div3rsa/model-sdk";
import type { AgentToolRuntime } from "./contracts";
import { AgentOrchestrator, InMemoryRunRepository, LoopGuard, assertTransition, routeSkills } from "./index";

const model: ModelAdapter = {
  async generate(request: GenerateRequest) { return { modelVersionId: "test-model", content: `ok:${request.alias}`, finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 } }; },
  async *stream() { yield "ok"; },
  async estimateTokens() { return 1; },
  getCapabilities() { return new Set(["general"] as const); },
  async healthCheck() { return { ok: true, latencyMs: 1 }; }
};

function scriptedModel(results: GenerateResult[], requests: GenerateRequest[]): ModelAdapter {
  return {
    async generate(request: GenerateRequest) {
      requests.push(request);
      const result = results.shift();
      if (!result) throw new Error("unexpected_model_call");
      return result;
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

const baseRequest = {
  requestId: "req-tool",
  traceId: "trace-tool",
  conversationId: "conversation-tool",
  mode: "chat" as const,
  prompt: "Check this",
  actor: { userId: "user-1", organizationId: "org-1", workspaceId: "ws-1", permissions: new Set(["agent.run"]), assuranceLevel: "aal1" as const }
};

describe("agent runtime", () => {
  it("routes process skills before verification and completes with checkpoints", async () => {
    const runs = new InMemoryRunRepository();
    const result = await new AgentOrchestrator({ model, runs }).run({
      requestId: "req-1", traceId: "trace-1", conversationId: "conversation-1", mode: "code", prompt: "Implement and test it",
      actor: { userId: "user-1", organizationId: "org-1", workspaceId: "ws-1", permissions: new Set(["agent.run"]), assuranceLevel: "aal1" }
    });
    expect(result.status).toBe("completed");
    expect(result.alias).toBe("code-prod");
    expect(result.steps.filter((step) => step.kind === "skill").map((step) => step.skill)).toEqual([
      "writing-plans", "repo-understanding", "test-driven-development", "browser-e2e", "verification-before-completion", "code-review"
    ]);
    expect(runs.checkpoints.length).toBe(result.steps.length);
  });

  it("executes structured tool calls and continues the model with tool results", async () => {
    const requests: GenerateRequest[] = [];
    const calls: string[] = [];
    const tools: AgentToolRuntime = {
      definitions: () => [{ name: "http_request", description: "Perform an authorized HTTP request", inputSchema: { type: "object" } }],
      capabilities: () => ({ httpRequests: true, sandbox: true, networkEgress: true }),
      async execute(call) {
        calls.push(call.name);
        return { ok: true, output: { status: 200, body: "live-result" } };
      }
    };
    const runs = new InMemoryRunRepository();
    const runtimeModel = scriptedModel([
      result("", "tool_call", [{ id: "call-1", name: "http_request", input: { url: "https://example.test" } }]),
      result("Verified from the tool result.", "stop")
    ], requests);

    const run = await new AgentOrchestrator({ model: runtimeModel, runs, tools }).run(baseRequest);

    expect(run.status).toBe("completed");
    expect(calls).toEqual(["http_request"]);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages.some((message) => message.role === "tool" && message.toolCallId === "call-1" && message.content.includes("live-result"))).toBe(true);
    expect(run.steps.some((step) => step.status === "waiting_for_tool")).toBe(true);
  });

  it("returns TOOL_UNAVAILABLE to the model instead of hanging on an unknown tool", async () => {
    const requests: GenerateRequest[] = [];
    let executions = 0;
    const tools: AgentToolRuntime = {
      definitions: () => [{ name: "http_request", description: "HTTP", inputSchema: { type: "object" } }],
      async execute() {
        executions += 1;
        return { ok: true };
      }
    };
    const runtimeModel = scriptedModel([
      result("", "tool_call", [{ id: "call-unknown", name: "shell", input: { command: "curl https://example.test" } }]),
      result("The requested execution tool is unavailable; no command was run.", "stop")
    ], requests);
    const runs = new InMemoryRunRepository();

    const run = await new AgentOrchestrator({ model: runtimeModel, runs, tools }).run(baseRequest);

    expect(run.status).toBe("completed");
    expect(executions).toBe(0);
    expect(requests[1]?.messages.some((message) => message.role === "tool" && message.content.includes("TOOL_UNAVAILABLE"))).toBe(true);
  });

  it("injects TOOL_TIMEOUT and keeps the run deterministic when a tool stalls", async () => {
    const requests: GenerateRequest[] = [];
    const tools: AgentToolRuntime = {
      definitions: () => [{ name: "http_request", description: "HTTP", inputSchema: { type: "object" } }],
      execute: async (_call, _context, signal) => new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve({ ok: false, error: "TOOL_TIMEOUT" }), { once: true });
      })
    };
    const runtimeModel = scriptedModel([
      result("", "tool_call", [{ id: "call-timeout", name: "http_request", input: { url: "https://example.test" } }]),
      result("The live request timed out, so I am not claiming a result.", "stop")
    ], requests);
    const runs = new InMemoryRunRepository();

    const run = await new AgentOrchestrator({ model: runtimeModel, runs, tools, toolTimeoutMs: 2 }).run(baseRequest);

    expect(run.status).toBe("completed");
    expect(requests[1]?.messages.some((message) => message.role === "tool" && message.content.includes("TOOL_TIMEOUT"))).toBe(true);
  });

  it("recovers once when the model writes curl as text instead of emitting a tool call", async () => {
    const requests: GenerateRequest[] = [];
    const runtimeModel = scriptedModel([
      result("Jag behöver bekräfta live innan jag svarar.\n```bash\ncurl https://example.test\n```", "stop"),
      result("Live execution is unavailable in this run, so the command was not executed.", "stop")
    ], requests);
    const runs = new InMemoryRunRepository();

    const run = await new AgentOrchestrator({ model: runtimeModel, runs }).run(baseRequest);

    expect(run.status).toBe("completed");
    expect(run.attempts).toBe(2);
    expect(run.steps.some((step) => step.status === "retrying" && step.summary.includes("missing structured tool call"))).toBe(true);
    expect(requests[1]?.messages.some((message) => message.role === "system" && message.content.includes("TOOL_UNAVAILABLE"))).toBe(true);
  });

  it("redacts API keys and JWTs from persisted prompts and final output", async () => {
    const requests: GenerateRequest[] = [];
    const jwt = "eyJabcdefghijk.abcdefghijklmnop.abcdefghijklmnop";
    const runtimeModel = scriptedModel([
      result(`Authorization: Bearer ${jwt} apikey: secret-value`, "stop")
    ], requests);
    const runs = new InMemoryRunRepository();

    const run = await new AgentOrchestrator({ model: runtimeModel, runs }).run({
      ...baseRequest,
      prompt: `Use apikey: secret-value and Authorization: Bearer ${jwt}`
    });

    expect(run.status).toBe("completed");
    expect(run.request.prompt).not.toContain("secret-value");
    expect(run.request.prompt).not.toContain(jwt);
    expect(run.output?.content).not.toContain("secret-value");
    expect(run.output?.content).not.toContain(jwt);
    expect(requests[0]?.messages.find((message) => message.role === "user")?.content).toContain("secret-value");
  });

  it("requires explicit unexpired authorization for Lab", async () => {
    const runs = new InMemoryRunRepository();
    await expect(new AgentOrchestrator({ model, runs }).run({
      requestId: "req-2", traceId: "trace-2", conversationId: "conversation-2", mode: "lab", prompt: "scan target",
      actor: { userId: "user-1", organizationId: "org-1", workspaceId: "ws-1", permissions: new Set(["lab.run"]), assuranceLevel: "aal1" }
    })).rejects.toThrow("lab_authorization_required");
  });

  it("rejects invalid state transitions and repeated loops", () => {
    expect(() => assertTransition("queued", "completed")).toThrow("invalid_run_transition");
    const guard = new LoopGuard(2, 10);
    guard.record({ action: "test", errorCode: "E", inputHash: "x" });
    guard.record({ action: "test", errorCode: "E", inputHash: "x" });
    expect(() => guard.record({ action: "test", errorCode: "E", inputHash: "x" })).toThrow("loop_repeated_attempt_detected");
  });

  it("always ends skill routing with verification", () => {
    expect(routeSkills("chat", "hello")).toEqual(["verification-before-completion"]);
  });
});
