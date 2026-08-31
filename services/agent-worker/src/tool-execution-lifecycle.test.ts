import { describe, expect, it } from "vitest";
import {
  canonicalInputHash,
  canonicalJson,
  isActiveToolExecutionStatus,
  isTerminalToolExecutionStatus,
  normalizeToolResult,
  operationId,
  toolCallId
} from "./tool-execution-lifecycle";

describe("tool execution lifecycle", () => {
  it("canonicalizes nested object keys before hashing", () => {
    const left = { z: 1, nested: { b: 2, a: 1 }, array: [{ d: 4, c: 3 }] };
    const right = { array: [{ c: 3, d: 4 }], nested: { a: 1, b: 2 }, z: 1 };
    expect(canonicalJson(left)).toBe(canonicalJson(right));
    expect(canonicalInputHash(left)).toBe(canonicalInputHash(right));
  });

  it("creates stable unique call and operation ids", () => {
    const first = toolCallId("run-1", 2, 0);
    const second = toolCallId("run-1", 2, 1);
    expect(first).toBe("run-1:2:0");
    expect(second).not.toBe(first);
    expect(operationId("run-1", first)).toBe(operationId("run-1", first));
    expect(operationId("run-1", second)).not.toBe(operationId("run-1", first));
  });

  it("only exposes active statuses as UI activity", () => {
    for (const status of ["queued", "running", "waiting", "retrying", "cancelling"]) expect(isActiveToolExecutionStatus(status)).toBe(true);
    for (const status of ["created", "completed", "failed", "cancelled", "blocked"]) expect(isActiveToolExecutionStatus(status)).toBe(false);
    expect(isTerminalToolExecutionStatus("completed")).toBe(true);
    expect(isTerminalToolExecutionStatus("cancelled")).toBe(true);
    expect(isTerminalToolExecutionStatus("blocked")).toBe(true);
  });

  it("normalizes legacy and canonical results without counting failures as success", () => {
    expect(normalizeToolResult({ ok: true, status: "completed", data: { value: 1 } })).toMatchObject({ ok: true, status: "completed" });
    expect(normalizeToolResult({ ok: false, status: "failed", error: { code: "network", retryable: true } })).toEqual({ ok: false, status: "failed", data: undefined, error: { code: "network", retryable: true } });
    expect(normalizeToolResult({ error: "boom" })).toEqual({ ok: false, status: "failed", data: undefined, error: { code: "boom", retryable: false } });
  });
});
