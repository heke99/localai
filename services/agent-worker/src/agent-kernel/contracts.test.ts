import { describe, expect, it } from "vitest";
import { agentKernelConfigFromEnvironment } from "./config";
import {
  AGENT_KERNEL_PROTOCOL_VERSION,
  AgentKernelContractError,
  assertValidKernelPlan,
  type KernelPlan
} from "./contracts";

function validPlan(): KernelPlan {
  return {
    protocolVersion: AGENT_KERNEL_PROTOCOL_VERSION,
    task: {
      runId: "run-1",
      conversationId: "conversation-1",
      objective: "Inspect, implement and verify a safe change",
      mode: "code",
      requestedAt: "2026-08-29T00:00:00.000Z",
      capabilities: ["reasoning", "repository", "verification"]
    },
    agents: [
      { agentId: "planner", role: "planner", capabilities: ["reasoning"], modelAlias: "general-prod" },
      { agentId: "coder", role: "coder", capabilities: ["reasoning", "repository"], modelAlias: "general-prod" },
      { agentId: "verifier", role: "verifier", capabilities: ["reasoning", "verification"], modelAlias: "general-prod" }
    ],
    steps: [
      {
        id: "plan",
        objective: "Produce a bounded implementation plan",
        assignedAgentId: "planner",
        dependsOn: [],
        requiredCapabilities: ["reasoning"],
        verificationRequired: false
      },
      {
        id: "implement",
        objective: "Implement the planned change",
        assignedAgentId: "coder",
        dependsOn: ["plan"],
        requiredCapabilities: ["repository"],
        verificationRequired: true
      },
      {
        id: "verify",
        objective: "Verify the implementation against evidence",
        assignedAgentId: "verifier",
        dependsOn: ["implement"],
        requiredCapabilities: ["verification"],
        verificationRequired: true
      }
    ],
    finalVerifierAgentId: "verifier"
  };
}

describe("Agent Kernel V2 contracts", () => {
  it("accepts a valid dependency-ordered multi-agent plan", () => {
    expect(() => assertValidKernelPlan(validPlan())).not.toThrow();
  });

  it("rejects duplicate identities, missing capabilities and dependency cycles", () => {
    const duplicateAgent = validPlan();
    expect(() => assertValidKernelPlan({ ...duplicateAgent, agents: [...duplicateAgent.agents, duplicateAgent.agents[0]!] }))
      .toThrowError(AgentKernelContractError);

    const missingCapability = validPlan();
    expect(() => assertValidKernelPlan({
      ...missingCapability,
      agents: missingCapability.agents.map((agent) => agent.agentId === "coder" ? { ...agent, capabilities: ["reasoning"] as const } : agent)
    })).toThrow(/lacks capability repository/);

    const cyclic = validPlan();
    expect(() => assertValidKernelPlan({
      ...cyclic,
      steps: cyclic.steps.map((step) => step.id === "plan" ? { ...step, dependsOn: ["verify"] } : step)
    })).toThrow(/Cycle detected/);
  });

  it("requires the final verifier to have verification capability", () => {
    const plan = validPlan();
    expect(() => assertValidKernelPlan({ ...plan, finalVerifierAgentId: "planner" })).toThrow(/lacks verification capability/);
  });
});

describe("Agent Kernel V2 rollout config", () => {
  it("defaults fail-closed to the legacy production path", () => {
    expect(agentKernelConfigFromEnvironment({})).toEqual({
      enabled: false,
      mode: "legacy",
      maxSubagents: 4,
      maxParallelSubagents: 2,
      verificationRequired: true
    });
  });

  it("cannot activate shadow or active mode while the kernel is disabled", () => {
    expect(agentKernelConfigFromEnvironment({ DIV3RSA_AGENT_KERNEL_V2_MODE: "active" })).toMatchObject({ enabled: false, mode: "legacy" });
    expect(agentKernelConfigFromEnvironment({ DIV3RSA_AGENT_KERNEL_V2_MODE: "shadow" })).toMatchObject({ enabled: false, mode: "legacy" });
  });

  it("supports explicit shadow rollout while keeping verification on", () => {
    expect(agentKernelConfigFromEnvironment({
      DIV3RSA_AGENT_KERNEL_V2_ENABLED: "1",
      DIV3RSA_AGENT_KERNEL_V2_MODE: "shadow",
      DIV3RSA_AGENT_KERNEL_V2_MAX_SUBAGENTS: "6",
      DIV3RSA_AGENT_KERNEL_V2_MAX_PARALLEL_SUBAGENTS: "3"
    })).toEqual({ enabled: true, mode: "shadow", maxSubagents: 6, maxParallelSubagents: 3, verificationRequired: true });
  });

  it("rejects impossible concurrency budgets", () => {
    expect(() => agentKernelConfigFromEnvironment({
      DIV3RSA_AGENT_KERNEL_V2_ENABLED: "1",
      DIV3RSA_AGENT_KERNEL_V2_MAX_SUBAGENTS: "2",
      DIV3RSA_AGENT_KERNEL_V2_MAX_PARALLEL_SUBAGENTS: "3"
    })).toThrow(/parallel_subagents_exceeds_total/);
  });
});
