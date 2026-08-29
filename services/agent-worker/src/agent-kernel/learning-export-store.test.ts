import { describe, expect, it, vi } from "vitest";
import { SupabaseAgentKernelStore, type AgentKernelStoreRpcClient } from "./store";

const envelope = {
  schemaVersion: 1 as const,
  queryVersion: "verified-learning-v1" as const,
  createdBefore: "2026-08-29T21:00:00.000Z",
  minReward: 1,
  records: []
};

describe("SupabaseAgentKernelStore verified learning export", () => {
  it("uses the bounded service-role RPC with an explicit cutoff", async () => {
    const rpc = vi.fn(async () => ({ data: envelope, error: null }));
    const store = new SupabaseAgentKernelStore({ rpc } as unknown as AgentKernelStoreRpcClient);
    await expect(store.exportVerifiedLearning({ minReward: 0, limit: 99999, createdBefore: envelope.createdBefore })).resolves.toEqual(envelope);
    expect(rpc).toHaveBeenCalledWith("worker_export_verified_agent_learning", {
      target_min_reward: 1,
      target_limit: 5000,
      target_created_before: envelope.createdBefore
    });
  });

  it("rejects a missing or invalid immutable cutoff before RPC", async () => {
    const rpc = vi.fn();
    const store = new SupabaseAgentKernelStore({ rpc } as unknown as AgentKernelStoreRpcClient);
    await expect(store.exportVerifiedLearning({ createdBefore: "not-a-date" })).rejects.toThrow("invalid_learning_export_cutoff");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("fails closed on an empty RPC response", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: null }));
    const store = new SupabaseAgentKernelStore({ rpc } as unknown as AgentKernelStoreRpcClient);
    await expect(store.exportVerifiedLearning({ createdBefore: envelope.createdBefore })).rejects.toThrow("empty_response");
  });
});
