import type { RunStatus } from "./contracts";

const transitions: Record<RunStatus, ReadonlySet<RunStatus>> = {
  queued: new Set(["planning", "cancelled", "failed"]),
  planning: new Set(["running", "waiting_for_user", "cancelled", "failed"]),
  running: new Set(["waiting_for_tool", "verifying", "retrying", "cancelled", "failed", "timed_out"]),
  waiting_for_user: new Set(["running", "cancelled", "timed_out"]),
  waiting_for_tool: new Set(["running", "retrying", "cancelled", "failed", "timed_out"]),
  verifying: new Set(["completed", "retrying", "failed", "cancelled"]),
  retrying: new Set(["running", "verifying", "failed", "cancelled", "timed_out"]),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  timed_out: new Set()
};

export function assertTransition(from: RunStatus, to: RunStatus): void {
  if (!transitions[from].has(to)) throw new Error(`invalid_run_transition:${from}->${to}`);
}

export function isTerminal(status: RunStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "timed_out";
}
