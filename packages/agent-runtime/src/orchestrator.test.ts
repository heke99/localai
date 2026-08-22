import { describe, expect, it } from "vitest";
import type { GenerateRequest, ModelAdapter } from "@div3rsa/model-sdk";
import { AgentOrchestrator, InMemoryRunRepository, LoopGuard, assertTransition, routeSkills } from "./index";

const model: ModelAdapter = {
  async generate(request: GenerateRequest) { return { modelVersionId: "test-model", content: `ok:${request.alias}`, finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 } }; },
  async *stream() { yield "ok"; },
  async estimateTokens() { return 1; },
  getCapabilities() { return new Set(["general"] as const); },
  async healthCheck() { return { ok: true, latencyMs: 1 }; }
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
      "implementation-planning", "repo-understanding", "test-driven-development", "verification-before-completion"
    ]);
    expect(runs.checkpoints.length).toBe(result.steps.length);
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
