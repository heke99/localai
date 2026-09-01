import { createHash } from "node:crypto";

export interface AgentTrajectoryStep {
  readonly step: number;
  readonly reasoningMode: string;
  readonly tool: string | null;
  readonly argumentsDigest: string | null;
  readonly resultDigest: string | null;
  readonly latencyMs: number;
  readonly tokens: number;
  readonly cachedTokens: number;
  readonly sourceQuality: number | null;
  readonly testsBefore: number | null;
  readonly testsAfter: number | null;
  readonly verificationResult: "passed" | "failed" | "skipped";
}

export interface AgentTrajectory {
  readonly trajectoryId: string;
  readonly agentRunId: string;
  readonly modelVersion: string;
  readonly promptVersion: string;
  readonly steps: readonly AgentTrajectoryStep[];
  readonly userFeedback: "accepted" | "rejected" | "unknown";
  readonly reward: number;
  readonly createdAt: string;
}

export interface RewardSignals {
  readonly exactOracleCorrect?: boolean;
  readonly allTestsPass?: boolean;
  readonly independentVerificationPassed?: boolean;
  readonly userAccepted?: boolean;
  readonly fewerToolCalls?: boolean;
  readonly lowerLatency?: boolean;
  readonly hallucination?: boolean;
  readonly regression?: boolean;
  readonly unnecessarySearch?: boolean;
  readonly repeatedFailedTool?: boolean;
}

export function rewardFromSignals(signals: RewardSignals): number {
  let reward = 0;
  if (signals.exactOracleCorrect) reward += 5;
  if (signals.allTestsPass) reward += 5;
  if (signals.independentVerificationPassed) reward += 5;
  if (signals.userAccepted) reward += 3;
  if (signals.fewerToolCalls) reward += 2;
  if (signals.lowerLatency) reward += 1;
  if (signals.hallucination) reward -= 5;
  if (signals.regression) reward -= 5;
  if (signals.unnecessarySearch) reward -= 3;
  if (signals.repeatedFailedTool) reward -= 3;
  return reward;
}

export function digestTrajectoryValue(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function buildTrajectory(input: {
  agentRunId: string;
  modelVersion: string;
  promptVersion: string;
  steps: readonly AgentTrajectoryStep[];
  userFeedback?: AgentTrajectory["userFeedback"];
  signals: RewardSignals;
}): AgentTrajectory {
  const createdAt = new Date().toISOString();
  const reward = rewardFromSignals(input.signals);
  const trajectoryId = createHash("sha256")
    .update(JSON.stringify({ run: input.agentRunId, model: input.modelVersion, prompt: input.promptVersion, steps: input.steps, reward }))
    .digest("hex");
  return {
    trajectoryId,
    agentRunId: input.agentRunId,
    modelVersion: input.modelVersion,
    promptVersion: input.promptVersion,
    steps: input.steps.map((step) => ({ ...step })),
    userFeedback: input.userFeedback ?? "unknown",
    reward,
    createdAt
  };
}

export function trajectoryEligibleForTraining(trajectory: AgentTrajectory): boolean {
  if (trajectory.reward <= 0 || trajectory.steps.length === 0) return false;
  return trajectory.steps.every((step) => step.verificationResult !== "failed")
    && trajectory.steps.some((step) => step.verificationResult === "passed");
}
