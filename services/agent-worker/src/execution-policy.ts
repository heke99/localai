import type { TaskAnalysis } from "@div3rsa/agent-runtime";

export interface AgentExecutionPolicy {
  verificationRounds: number;
  maxToolIterations: number;
  maxModelTurns: number;
}

export function executionPolicyFor(task: TaskAnalysis): AgentExecutionPolicy {
  const heavyExecution = task.requiresRepository
    || task.requiresDatabase
    || task.requiresDeployment
    || task.requiresSecurityReview;

  if (task.risk === "critical" || task.risk === "high" || heavyExecution) {
    return { verificationRounds: 3, maxToolIterations: 8, maxModelTurns: 12 };
  }

  if (task.risk === "medium") {
    return { verificationRounds: 2, maxToolIterations: 6, maxModelTurns: 9 };
  }

  if (task.requiresLiveData) {
    return { verificationRounds: 1, maxToolIterations: 3, maxModelTurns: 4 };
  }

  if (task.requiresCurrentInformation) {
    return task.researchDepth === "deep"
      ? { verificationRounds: 2, maxToolIterations: 6, maxModelTurns: 8 }
      : { verificationRounds: 1, maxToolIterations: 4, maxModelTurns: 6 };
  }

  if (task.reasoningLevel === "deep") {
    return { verificationRounds: 2, maxToolIterations: 5, maxModelTurns: 7 };
  }

  return { verificationRounds: 1, maxToolIterations: 2, maxModelTurns: 3 };
}
