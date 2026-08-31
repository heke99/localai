import { createHash } from "node:crypto";

export type ToolExecutionStatus =
  | "created"
  | "queued"
  | "running"
  | "waiting"
  | "retrying"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled"
  | "blocked";

export interface ToolExecutionStart {
  runId: string;
  toolCallId: string;
  operationId: string;
  toolName: string;
  inputHash: string;
  inputRedacted: Record<string, unknown>;
  mutating: boolean;
  reversible: boolean;
  scopeSnapshot?: Record<string, unknown> | null;
}

export interface ToolExecutionTransition {
  executionId: string;
  status: ToolExecutionStatus;
  attempt?: number;
  outputSummary?: unknown;
  errorCode?: string | null;
  retryable?: boolean | null;
  providerResourceId?: string | null;
  externalOperationId?: string | null;
  rollbackStatus?: "not_required" | "pending" | "running" | "completed" | "failed" | null;
}

const TERMINAL = new Set<ToolExecutionStatus>(["completed", "failed", "cancelled", "blocked"]);
const ACTIVE = new Set<ToolExecutionStatus>(["queued", "running", "waiting", "retrying", "cancelling"]);

export function isActiveToolExecutionStatus(status: string | null | undefined): status is ToolExecutionStatus {
  return typeof status === "string" && ACTIVE.has(status as ToolExecutionStatus);
}

export function isTerminalToolExecutionStatus(status: string | null | undefined): status is ToolExecutionStatus {
  return typeof status === "string" && TERMINAL.has(status as ToolExecutionStatus);
}

export function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalizeJson(entry)])
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalizeJson(value));
}

export function canonicalInputHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function toolCallId(runId: string, modelTurn: number, toolIndex: number): string {
  if (!runId) throw new Error("run_id_required");
  if (!Number.isInteger(modelTurn) || modelTurn < 0) throw new Error("model_turn_invalid");
  if (!Number.isInteger(toolIndex) || toolIndex < 0) throw new Error("tool_index_invalid");
  return `${runId}:${modelTurn}:${toolIndex}`;
}

export function operationId(runId: string, stableToolCallId: string): string {
  return createHash("sha256").update(`${runId}\u0000${stableToolCallId}`).digest("hex");
}

export function normalizeToolResult(output: unknown): {
  ok: boolean;
  status: "completed" | "failed" | "cancelled" | "blocked";
  data?: unknown;
  error?: { code: string; retryable: boolean };
} {
  if (output && typeof output === "object") {
    const record = output as Record<string, unknown>;
    if (record.status === "cancelled") return { ok: false, status: "cancelled", data: record.data, error: { code: String((record.error as Record<string, unknown> | undefined)?.code ?? "tool_cancelled"), retryable: false } };
    if (record.status === "blocked") return { ok: false, status: "blocked", data: record.data, error: { code: String((record.error as Record<string, unknown> | undefined)?.code ?? "tool_blocked"), retryable: false } };
    if (record.ok === false || record.status === "failed" || typeof record.error === "string") {
      const nested = record.error && typeof record.error === "object" ? record.error as Record<string, unknown> : undefined;
      return { ok: false, status: "failed", data: record.data, error: { code: String(nested?.code ?? record.error ?? "tool_failed"), retryable: nested?.retryable === true || record.retryable === true } };
    }
    if (record.ok === true || record.status === "completed") return { ok: true, status: "completed", data: record.data ?? output };
  }
  return { ok: true, status: "completed", data: output };
}
