import type { ResearchDepth, TaskAnalysis } from "./task-analyzer";

export type ExecutionTier = "FAST" | "STANDARD" | "DEEP" | "CRITICAL";
export type RepositoryDepth = "none" | "targeted" | "dependency" | "full";
export type ToolGroup = "live" | "research" | "repository" | "browser" | "database" | "deployment" | "security";

export interface AgentExecutionPolicy {
  tier: ExecutionTier;
  verificationRounds: number;
  maxToolIterations: number;
  maxModelTurns: number;
  maxContextTokens: number;
  timeoutMs: number;
  allowedToolGroups: ToolGroup[];
  requiredVerifiers: string[];
  repoDepth: RepositoryDepth;
  researchDepth: ResearchDepth;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function tierFor(task: TaskAnalysis): ExecutionTier {
  if (task.risk === "critical") return "CRITICAL";
  if (task.risk === "high" || task.complexity === "large" || task.reasoningLevel === "deep") return "DEEP";
  if (task.risk === "medium" || task.reasoningLevel === "standard" || task.requiresCurrentInformation || task.requiresRepository || task.requiresDatabase || task.requiresDeployment) return "STANDARD";
  return "FAST";
}

function contextBudget(tier: ExecutionTier): number {
  switch (tier) {
    case "FAST": return 8_000;
    case "STANDARD": return 16_000;
    case "DEEP": return 32_000;
    case "CRITICAL": return 48_000;
  }
}

function timeoutFor(tier: ExecutionTier): number {
  switch (tier) {
    case "FAST": return 30_000;
    case "STANDARD": return 120_000;
    case "DEEP": return 300_000;
    case "CRITICAL": return 600_000;
  }
}

function repositoryDepth(task: TaskAnalysis, tier: ExecutionTier): RepositoryDepth {
  if (!task.requiresRepository) return "none";
  if (tier === "CRITICAL" || task.categories.includes("architecture") || task.categories.includes("audit")) return "full";
  if (tier === "DEEP" || task.categories.includes("refactor") || task.categories.includes("debug")) return "dependency";
  return task.complexity === "small" ? "targeted" : "dependency";
}

function runtimeBudget(task: TaskAnalysis): Pick<AgentExecutionPolicy, "verificationRounds" | "maxToolIterations" | "maxModelTurns"> {
  const heavyExecution = task.requiresRepository || task.requiresDatabase || task.requiresDeployment || task.requiresSecurityReview;
  if (task.risk === "critical" || task.risk === "high" || heavyExecution) return { verificationRounds: 3, maxToolIterations: 8, maxModelTurns: 12 };
  if (task.risk === "medium") return { verificationRounds: 2, maxToolIterations: 6, maxModelTurns: 9 };
  if (task.requiresLiveData) return { verificationRounds: 1, maxToolIterations: 3, maxModelTurns: 4 };
  if (task.requiresCurrentInformation) return task.researchDepth === "deep"
    ? { verificationRounds: 2, maxToolIterations: 6, maxModelTurns: 8 }
    : { verificationRounds: 1, maxToolIterations: 4, maxModelTurns: 6 };
  if (task.reasoningLevel === "deep") return { verificationRounds: 2, maxToolIterations: 5, maxModelTurns: 7 };
  return { verificationRounds: 1, maxToolIterations: 2, maxModelTurns: 3 };
}

function allowedToolGroups(task: TaskAnalysis): ToolGroup[] {
  return unique([
    ...(task.requiresLiveData ? ["live" as const] : []),
    ...(task.requiresCurrentInformation ? ["research" as const] : []),
    ...(task.requiresRepository ? ["repository" as const] : []),
    ...(task.requiresBrowser ? ["browser" as const] : []),
    ...(task.requiresDatabase ? ["database" as const] : []),
    ...(task.requiresDeployment ? ["deployment" as const] : []),
    ...(task.requiresSecurityReview ? ["security" as const] : [])
  ]);
}

export function executionPolicyFor(task: TaskAnalysis): AgentExecutionPolicy {
  const tier = tierFor(task);
  return {
    tier,
    ...runtimeBudget(task),
    maxContextTokens: contextBudget(tier),
    timeoutMs: timeoutFor(tier),
    allowedToolGroups: allowedToolGroups(task),
    requiredVerifiers: unique(task.verificationRequirements),
    repoDepth: repositoryDepth(task, tier),
    researchDepth: task.researchDepth
  };
}
