import { describe, expect, it } from "vitest";
import { MemoryEngine, memoryPartitionKey, validateMemoryWrite, type MemoryRecord } from "./index";

const base = {
  id: "m1",
  content: "Use typed migrations.",
  createdAt: "2026-08-27T12:00:00.000Z",
  updatedAt: "2026-08-27T12:00:00.000Z",
  trust: "verified" as const,
  version: 1,
  expiresAt: null,
  scope: { organizationId: "org-1", workspaceId: "ws-1", projectId: "project-1", userId: "user-1", conversationId: "conv-1" }
};

function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return { ...base, kind: "conversation", source: { type: "conversation", reference: "conv-1", approved: false }, ...overrides };
}

describe("memory runtime", () => {
  it("keeps the four memory classes in separate physical partitions", () => {
    expect(memoryPartitionKey(record())).toContain("conversation:");
    expect(memoryPartitionKey(record({ kind: "project", source: { type: "project", reference: "decision-1", approved: true } }))).toContain("project:");
    expect(memoryPartitionKey(record({ kind: "knowledge", source: { type: "ingestion", reference: "doc-1", approved: true } }))).toContain("knowledge:");
    expect(memoryPartitionKey(record({ kind: "policy", trust: "authoritative", source: { type: "policy", reference: "policy-1", approved: true } }))).toContain("policy:");
  });

  it("does not silently promote unapproved data into durable knowledge or policy", () => {
    expect(() => validateMemoryWrite(record({ kind: "knowledge", source: { type: "conversation", reference: "conv-1", approved: false } }))).toThrow("durable_memory_approval_required");
    expect(() => validateMemoryWrite(record({ kind: "policy", source: { type: "policy", reference: "p1", approved: true }, trust: "verified" }))).toThrow("policy_memory_authority_required");
  });

  it("isolates conversation memory by user and conversation", () => {
    const engine = new MemoryEngine([record()]);
    expect(engine.select({ scope: base.scope })).toHaveLength(1);
    expect(engine.select({ scope: { ...base.scope, userId: "user-2" } })).toHaveLength(0);
    expect(engine.select({ scope: { ...base.scope, conversationId: "conv-2" } })).toHaveLength(0);
  });

  it("drops expired memory from retrieval", () => {
    const engine = new MemoryEngine([record({ expiresAt: "2026-08-27T12:30:00.000Z" })]);
    expect(engine.select({ scope: base.scope, now: new Date("2026-08-27T13:00:00.000Z") })).toHaveLength(0);
  });
});
