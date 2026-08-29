import { describe, expect, it, vi } from "vitest";
import type { GenerateRequest, ModelAdapter } from "@div3rsa/model-sdk";
import type { AgentKernelConfig } from "./config";
import { AgentKernelActiveCanaryAdapter } from "./active-canary-adapter";

const config: AgentKernelConfig = {
  enabled: true,
  mode: "active",
  maxSubagents: 2,
  maxParallelSubagents: 2,
  verificationRequired: true,
  activeCanaryBasisPoints: 10_000,
  activeTimeoutMsPerCall: 1_000,
  activeMaxOutputTokensPerCall: 64
};

function inner() {
  const generate = vi.fn(async (request: GenerateRequest) => {
    if (request.requestId.includes("agent-kernel-active:planner")) return { modelVersionId: "m", content: "PLAN_SAFE", finishReason: "stop" as const, usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 } };
    if (request.requestId.includes("agent-kernel-active:analyst")) return { modelVersionId: "m", content: "RISKS_SAFE", finishReason: "stop" as const, usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 } };
    return { modelVersionId: "m", content: request.messages[0]?.content ?? "", finishReason: "stop" as const, usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 } };
  });
  const adapter: ModelAdapter = {
    generate,
    async *stream(request) { yield (await generate(request)).content; },
    estimateTokens: async () => 1,
    getCapabilities: () => new Set(["general"]),
    healthCheck: async () => ({ ok: true, latencyMs: 1 })
  };
  return { adapter, generate };
}

function primaryRequest(): GenerateRequest {
  return {
    requestId: "req-root:0:0",
    alias: "general-prod",
    messages: [
      { role: "system", content: "Mode: code. Active skills: repository-analysis. Task risk: medium. Reasoning policy: STANDARD. Required verification: tests. Execution tier: STANDARD.\n\nExecution contract:\n{}" },
      { role: "user", content: "Analyze the repository and make a safe change" }
    ]
  };
}

describe("AgentKernelActiveCanaryAdapter", () => {
  it("injects bounded subagent conclusions into sampled primary execution only", async () => {
    const { adapter, generate } = inner();
    const wrapped = new AgentKernelActiveCanaryAdapter(adapter, config);
    const result = await wrapped.generate(primaryRequest());
    expect(result.content).toContain("PLAN_SAFE");
    expect(result.content).toContain("RISKS_SAFE");
    expect(result.content).toContain("actual tool evidence and independent verification remain authoritative");
    expect(generate).toHaveBeenCalledTimes(3);
  });

  it("caches one canary plan across the same run instead of multiplying subagent calls", async () => {
    const { adapter, generate } = inner();
    const wrapped = new AgentKernelActiveCanaryAdapter(adapter, config);
    await wrapped.generate(primaryRequest());
    await wrapped.generate({ ...primaryRequest(), requestId: "req-root:0:1" });
    expect(generate).toHaveBeenCalledTimes(4);
  });

  it("never augments verifier/internal model requests lacking the primary execution contract", async () => {
    const { adapter, generate } = inner();
    const wrapped = new AgentKernelActiveCanaryAdapter(adapter, config);
    await wrapped.generate({ requestId: "req:review:1", alias: "verifier-prod", messages: [{ role: "system", content: "You are a verifier" }, { role: "user", content: "review" }] });
    expect(generate).toHaveBeenCalledTimes(1);
  });
});
