import type { TaskAnalysis } from "./task-analyzer";

export type QueueLane = "interactive" | "normal" | "deep" | "background";

export interface QueueScheduling {
  lane: QueueLane;
  basePriority: number;
  agingStepMs: number;
  agingPointsPerStep: number;
  activeOwnerPenalty: number;
}

export interface QueueCandidate {
  basePriority: number;
  createdAt: string;
  activeForOwner: number;
}

const defaults: Record<QueueLane, number> = {
  interactive: 10,
  normal: 50,
  deep: 90,
  background: 130
};

export function queueSchedulingFor(task: TaskAnalysis, background = false): QueueScheduling {
  const lane: QueueLane = background
    ? "background"
    : task.reasoningLevel === "fast" && task.risk === "low" && task.complexity === "small"
      ? "interactive"
      : task.reasoningLevel === "deep" || task.risk === "critical" || task.risk === "high" || task.complexity === "large"
        ? "deep"
        : "normal";
  return {
    lane,
    basePriority: defaults[lane],
    agingStepMs: 30_000,
    agingPointsPerStep: 5,
    activeOwnerPenalty: 25
  };
}

export function effectiveQueuePriority(candidate: QueueCandidate, nowMs = Date.now()): number {
  const created = Date.parse(candidate.createdAt);
  if (!Number.isFinite(created)) throw new Error("queue_created_at_invalid");
  const waitedMs = Math.max(0, nowMs - created);
  const aging = Math.floor(waitedMs / 30_000) * 5;
  const ownerPenalty = Math.max(0, candidate.activeForOwner) * 25;
  return Math.max(0, candidate.basePriority - aging) + ownerPenalty;
}

export function compareQueueCandidates(a: QueueCandidate, b: QueueCandidate, nowMs = Date.now()): number {
  const priorityDelta = effectiveQueuePriority(a, nowMs) - effectiveQueuePriority(b, nowMs);
  if (priorityDelta !== 0) return priorityDelta;
  return Date.parse(a.createdAt) - Date.parse(b.createdAt);
}
