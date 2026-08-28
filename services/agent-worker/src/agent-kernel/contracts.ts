export const AGENT_KERNEL_PROTOCOL_VERSION = 2 as const;

export type KernelRunMode = "legacy" | "shadow" | "active";
export type KernelCapability = "reasoning" | "research" | "repository" | "database" | "browser" | "tooling" | "verification" | "memory";
export type KernelAgentRole = "planner" | "executor" | "researcher" | "coder" | "reviewer" | "verifier";
export type KernelStepStatus = "pending" | "running" | "completed" | "failed" | "blocked" | "skipped";
export type VerificationSeverity = "info" | "warning" | "error" | "critical";

export interface KernelTask {
  readonly runId: string;
  readonly conversationId: string | null;
  readonly objective: string;
  readonly mode: string;
  readonly requestedAt: string;
  readonly capabilities: readonly KernelCapability[];
}

export interface KernelAgentAssignment {
  readonly agentId: string;
  readonly role: KernelAgentRole;
  readonly capabilities: readonly KernelCapability[];
  readonly modelAlias: string;
}

export interface KernelPlanStep {
  readonly id: string;
  readonly objective: string;
  readonly assignedAgentId: string;
  readonly dependsOn: readonly string[];
  readonly requiredCapabilities: readonly KernelCapability[];
  readonly verificationRequired: boolean;
}

export interface KernelPlan {
  readonly protocolVersion: typeof AGENT_KERNEL_PROTOCOL_VERSION;
  readonly task: KernelTask;
  readonly agents: readonly KernelAgentAssignment[];
  readonly steps: readonly KernelPlanStep[];
  readonly finalVerifierAgentId: string | null;
}

export interface KernelEvidenceRef {
  readonly id: string;
  readonly kind: "tool" | "source" | "repository" | "database" | "test" | "model" | "memory";
  readonly locator: string;
  readonly observedAt: string;
  readonly digest?: string;
}

export interface KernelStepResult {
  readonly stepId: string;
  readonly status: KernelStepStatus;
  readonly summary: string;
  readonly evidence: readonly KernelEvidenceRef[];
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly errorCode: string | null;
}

export interface KernelVerificationFinding {
  readonly code: string;
  readonly severity: VerificationSeverity;
  readonly message: string;
  readonly evidenceIds: readonly string[];
}

export interface KernelVerificationReport {
  readonly passed: boolean;
  readonly verifierAgentId: string;
  readonly findings: readonly KernelVerificationFinding[];
  readonly verifiedAt: string;
}

export interface KernelExecutionResult {
  readonly protocolVersion: typeof AGENT_KERNEL_PROTOCOL_VERSION;
  readonly runId: string;
  readonly status: "completed" | "failed" | "blocked";
  readonly steps: readonly KernelStepResult[];
  readonly verification: KernelVerificationReport | null;
}

export interface KernelCheckpoint {
  readonly protocolVersion: typeof AGENT_KERNEL_PROTOCOL_VERSION;
  readonly runId: string;
  readonly plan: KernelPlan;
  readonly results: readonly KernelStepResult[];
  readonly createdAt: string;
}

export class AgentKernelContractError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "AgentKernelContractError";
  }
}

function requireNonBlank(value: string, code: string) {
  if (!value.trim()) throw new AgentKernelContractError(code, `${code}: value must not be blank`);
}

function requireUnique(values: readonly string[], code: string) {
  if (new Set(values).size !== values.length) throw new AgentKernelContractError(code, `${code}: values must be unique`);
}

export function assertValidKernelPlan(plan: KernelPlan): void {
  if (plan.protocolVersion !== AGENT_KERNEL_PROTOCOL_VERSION) {
    throw new AgentKernelContractError("unsupported_protocol_version", `Expected protocol ${AGENT_KERNEL_PROTOCOL_VERSION}`);
  }

  requireNonBlank(plan.task.runId, "missing_run_id");
  requireNonBlank(plan.task.objective, "missing_task_objective");

  const agentIds = plan.agents.map((agent) => agent.agentId);
  const stepIds = plan.steps.map((step) => step.id);
  requireUnique(agentIds, "duplicate_agent_id");
  requireUnique(stepIds, "duplicate_step_id");

  const agents = new Map(plan.agents.map((agent) => [agent.agentId, agent]));
  const steps = new Map(plan.steps.map((step) => [step.id, step]));

  for (const agent of plan.agents) {
    requireNonBlank(agent.agentId, "missing_agent_id");
    requireNonBlank(agent.modelAlias, "missing_model_alias");
  }

  for (const step of plan.steps) {
    requireNonBlank(step.id, "missing_step_id");
    requireNonBlank(step.objective, "missing_step_objective");
    const agent = agents.get(step.assignedAgentId);
    if (!agent) throw new AgentKernelContractError("unknown_step_agent", `Step ${step.id} references unknown agent ${step.assignedAgentId}`);
    for (const dependency of step.dependsOn) {
      if (!steps.has(dependency)) throw new AgentKernelContractError("unknown_step_dependency", `Step ${step.id} depends on unknown step ${dependency}`);
      if (dependency === step.id) throw new AgentKernelContractError("self_step_dependency", `Step ${step.id} cannot depend on itself`);
    }
    for (const capability of step.requiredCapabilities) {
      if (!agent.capabilities.includes(capability)) {
        throw new AgentKernelContractError("agent_missing_capability", `Agent ${agent.agentId} lacks capability ${capability} required by step ${step.id}`);
      }
    }
  }

  if (plan.finalVerifierAgentId !== null) {
    const verifier = agents.get(plan.finalVerifierAgentId);
    if (!verifier) throw new AgentKernelContractError("unknown_verifier_agent", `Unknown verifier ${plan.finalVerifierAgentId}`);
    if (!verifier.capabilities.includes("verification")) {
      throw new AgentKernelContractError("verifier_missing_capability", `Verifier ${verifier.agentId} lacks verification capability`);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (stepId: string) => {
    if (visited.has(stepId)) return;
    if (visiting.has(stepId)) throw new AgentKernelContractError("cyclic_step_dependency", `Cycle detected at step ${stepId}`);
    visiting.add(stepId);
    for (const dependency of steps.get(stepId)?.dependsOn ?? []) visit(dependency);
    visiting.delete(stepId);
    visited.add(stepId);
  };
  for (const stepId of stepIds) visit(stepId);
}
