import type { TaskAnalysis } from "@div3rsa/agent-runtime";
import type { ModelAlias } from "@div3rsa/model-sdk";
import type { AgentKernelConfig } from "./config";
import {
  AGENT_KERNEL_PROTOCOL_VERSION,
  assertValidKernelPlan,
  type KernelAgentAssignment,
  type KernelCapability,
  type KernelPlan,
  type KernelPlanStep,
  type KernelTask
} from "./contracts";

export interface ShadowKernelInput {
  readonly runId: string;
  readonly conversationId: string | null;
  readonly mode: string;
  readonly modelAlias: ModelAlias;
  readonly objective: string;
  readonly task: TaskAnalysis;
  readonly availableToolNames: readonly string[];
  readonly requestedAt?: string;
}

export interface ShadowKernelObservation {
  readonly protocolVersion: typeof AGENT_KERNEL_PROTOCOL_VERSION;
  readonly mode: "shadow";
  readonly plan: KernelPlan;
  readonly parallelWaves: readonly (readonly string[])[];
  readonly metrics: {
    readonly agentCount: number;
    readonly stepCount: number;
    readonly maxParallelWidth: number;
    readonly requiresVerification: boolean;
  };
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function optionalCapability(enabled: boolean, capability: KernelCapability): KernelCapability[] {
  return enabled ? [capability] : [];
}

function taskCapabilities(task: TaskAnalysis, toolNames: readonly string[]): KernelCapability[] {
  const capabilities: KernelCapability[] = ["reasoning"];
  if (task.requiresCurrentInformation || task.researchDepth !== "none") capabilities.push("research");
  if (task.requiresRepository) capabilities.push("repository");
  if (task.requiresDatabase) capabilities.push("database");
  if (task.requiresBrowser) capabilities.push("browser");
  if (toolNames.length > 0) capabilities.push("tooling");
  if (task.verificationRequirements.length > 0) capabilities.push("verification");
  return unique(capabilities);
}

function addAgent(
  agents: KernelAgentAssignment[],
  maxSubagents: number,
  agent: KernelAgentAssignment
): KernelAgentAssignment | null {
  if (agents.length >= maxSubagents) return null;
  agents.push(agent);
  return agent;
}

function buildPlan(input: ShadowKernelInput, config: AgentKernelConfig): KernelPlan {
  const task: KernelTask = {
    runId: input.runId,
    conversationId: input.conversationId,
    objective: input.objective,
    mode: input.mode,
    requestedAt: input.requestedAt ?? new Date().toISOString(),
    capabilities: taskCapabilities(input.task, input.availableToolNames)
  };

  const agents: KernelAgentAssignment[] = [];
  const steps: KernelPlanStep[] = [];
  const planner = addAgent(agents, config.maxSubagents, {
    agentId: "planner",
    role: "planner",
    capabilities: ["reasoning"],
    modelAlias: input.modelAlias
  });
  if (!planner) throw new Error("agent_kernel_shadow_budget_missing_planner");

  steps.push({
    id: "plan",
    objective: "Decompose the task into bounded evidence-backed work",
    assignedAgentId: planner.agentId,
    dependsOn: [],
    requiredCapabilities: ["reasoning"],
    verificationRequired: false
  });

  const executionStepIds: string[] = [];

  if (task.capabilities.includes("research")) {
    const researcherCapabilities: KernelCapability[] = [
      "reasoning",
      "research",
      ...optionalCapability(task.capabilities.includes("tooling"), "tooling")
    ];
    const researcher = addAgent(agents, config.maxSubagents, {
      agentId: "researcher",
      role: "researcher",
      capabilities: unique(researcherCapabilities),
      modelAlias: input.modelAlias
    });
    if (researcher) {
      steps.push({
        id: "research",
        objective: "Gather the minimum current evidence required by the task",
        assignedAgentId: researcher.agentId,
        dependsOn: ["plan"],
        requiredCapabilities: ["research"],
        verificationRequired: false
      });
      executionStepIds.push("research");
    }
  }

  const executionCapabilities: KernelCapability[] = (["repository", "database", "browser"] as const)
    .filter((capability) => task.capabilities.includes(capability));
  if (executionCapabilities.length > 0) {
    const executorCapabilities: KernelCapability[] = [
      "reasoning",
      ...executionCapabilities,
      ...optionalCapability(task.capabilities.includes("tooling"), "tooling")
    ];
    const executor = addAgent(agents, config.maxSubagents, {
      agentId: "executor",
      role: input.task.requiresRepository ? "coder" : "executor",
      capabilities: unique(executorCapabilities),
      modelAlias: input.modelAlias
    });
    if (executor) {
      steps.push({
        id: "execute",
        objective: "Execute scoped task work against the required project resources",
        assignedAgentId: executor.agentId,
        dependsOn: ["plan"],
        requiredCapabilities: executionCapabilities,
        verificationRequired: true
      });
      executionStepIds.push("execute");
    }
  }

  if (executionStepIds.length === 0) {
    const responderCapabilities: KernelCapability[] = [
      "reasoning",
      ...optionalCapability(task.capabilities.includes("tooling"), "tooling")
    ];
    const responder = addAgent(agents, config.maxSubagents, {
      agentId: "executor",
      role: "executor",
      capabilities: unique(responderCapabilities),
      modelAlias: input.modelAlias
    });
    if (responder) {
      steps.push({
        id: "execute",
        objective: "Produce the scoped candidate result",
        assignedAgentId: responder.agentId,
        dependsOn: ["plan"],
        requiredCapabilities: ["reasoning"],
        verificationRequired: true
      });
      executionStepIds.push("execute");
    }
  }

  let finalVerifierAgentId: string | null = null;
  if (config.verificationRequired || task.capabilities.includes("verification")) {
    const verifier = addAgent(agents, config.maxSubagents, {
      agentId: "verifier",
      role: "verifier",
      capabilities: ["reasoning", "verification"],
      modelAlias: "verifier-prod"
    });
    if (!verifier) throw new Error("agent_kernel_shadow_budget_missing_verifier");
    finalVerifierAgentId = verifier.agentId;
    steps.push({
      id: "verify",
      objective: "Independently verify completion against collected evidence",
      assignedAgentId: verifier.agentId,
      dependsOn: unique(executionStepIds),
      requiredCapabilities: ["verification"],
      verificationRequired: true
    });
  }

  const plan: KernelPlan = {
    protocolVersion: AGENT_KERNEL_PROTOCOL_VERSION,
    task,
    agents,
    steps,
    finalVerifierAgentId
  };
  assertValidKernelPlan(plan);
  return plan;
}

export function parallelWavesFor(plan: KernelPlan, maxParallel: number): readonly (readonly string[])[] {
  const remaining = new Map(plan.steps.map((step) => [step.id, step]));
  const completed = new Set<string>();
  const waves: string[][] = [];

  while (remaining.size > 0) {
    const ready = [...remaining.values()]
      .filter((step) => step.dependsOn.every((dependency) => completed.has(dependency)))
      .map((step) => step.id)
      .sort();
    if (ready.length === 0) throw new Error("agent_kernel_shadow_no_runnable_steps");

    for (let offset = 0; offset < ready.length; offset += maxParallel) {
      const wave = ready.slice(offset, offset + maxParallel);
      waves.push(wave);
      for (const stepId of wave) {
        completed.add(stepId);
        remaining.delete(stepId);
      }
    }
  }
  return waves;
}

export class AgentKernelShadowOrchestrator {
  constructor(private readonly config: AgentKernelConfig) {}

  observe(input: ShadowKernelInput): ShadowKernelObservation | null {
    if (!this.config.enabled || this.config.mode !== "shadow") return null;
    const plan = buildPlan(input, this.config);
    const parallelWaves = parallelWavesFor(plan, this.config.maxParallelSubagents);
    return {
      protocolVersion: AGENT_KERNEL_PROTOCOL_VERSION,
      mode: "shadow",
      plan,
      parallelWaves,
      metrics: {
        agentCount: plan.agents.length,
        stepCount: plan.steps.length,
        maxParallelWidth: Math.max(0, ...parallelWaves.map((wave) => wave.length)),
        requiresVerification: plan.finalVerifierAgentId !== null
      }
    };
  }
}
