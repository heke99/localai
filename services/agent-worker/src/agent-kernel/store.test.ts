import { describe, expect, it, vi } from "vitest";
import { SupabaseAgentKernelStore, type AgentKernelStoreRpcClient } from "./store";

function client() {
  const rpc = vi.fn(async (name: string, _args: Record<string, unknown>) => ({
    data: name === "worker_latest_verified_agent_kernel_checkpoint"
      ? { checkpoint_id: "cp-1", verified: true }
      : name === "worker_find_agent_memories"
        ? []
        : null,
    error: null
  }));
  return { rpc, store: new SupabaseAgentKernelStore({ rpc } as unknown as AgentKernelStoreRpcClient) };
}

describe("SupabaseAgentKernelStore", () => {
  it("persists verified checkpoints through the service-role RPC contract", async () => {
    const { rpc, store } = client();
    await store.recordCheckpoint({
      checkpointId: "cp-1",
      runId: "11111111-1111-4111-8111-111111111111",
      label: "before-mutation",
      snapshots: [{ kind: "repository", resourceId: "repo-1", revision: "a".repeat(40), restoreToken: "branch:work" }],
      verification: { passed: true, evidenceRefs: ["verification:baseline"] },
      verified: true,
      createdAt: new Date().toISOString()
    }, "b".repeat(64));

    expect(rpc).toHaveBeenCalledWith("worker_record_agent_kernel_checkpoint", expect.objectContaining({
      target_checkpoint_id: "cp-1",
      target_verified: true,
      target_plan_digest: "b".repeat(64)
    }));
  });

  it("keeps verified experience evidence and training eligibility explicit", async () => {
    const { rpc, store } = client();
    await store.upsertMemory({
      id: "memory-1",
      tier: "verified_experience",
      scope: "repo:heke99/localai",
      summary: "Problem: regression. Successful strategy: restore green revision.",
      evidenceRefs: ["verification:passed"],
      sourceRunId: "11111111-1111-4111-8111-111111111111",
      createdAt: new Date().toISOString(),
      verified: true,
      confidence: 1
    });
    await store.recordTrajectory({
      trajectoryId: "trajectory-1",
      agentRunId: "11111111-1111-4111-8111-111111111111",
      modelVersion: "qwen-v3-q8",
      promptVersion: "agent-kernel-v2",
      steps: [{ step: 1, reasoningMode: "standard", tool: "github_read_file", argumentsDigest: "a".repeat(64), resultDigest: "b".repeat(64), latencyMs: 10, tokens: 20, cachedTokens: 5, sourceQuality: 1, testsBefore: null, testsAfter: null, verificationResult: "passed" }],
      userFeedback: "unknown",
      reward: 5,
      createdAt: new Date().toISOString()
    }, true);

    expect(rpc).toHaveBeenCalledWith("worker_upsert_agent_memory", expect.objectContaining({ target_tier: "verified_experience", target_verified: true, target_evidence_refs: ["verification:passed"] }));
    expect(rpc).toHaveBeenCalledWith("worker_record_agent_trajectory", expect.objectContaining({ target_training_eligible: true, target_reward: 5 }));
  });

  it("reads only through bounded RPCs", async () => {
    const { rpc, store } = client();
    await expect(store.latestVerifiedCheckpoint("11111111-1111-4111-8111-111111111111")).resolves.toMatchObject({ verified: true });
    await expect(store.findMemories("repo:heke99/localai", 999)).resolves.toEqual([]);
    expect(rpc).toHaveBeenCalledWith("worker_find_agent_memories", { target_scope: "repo:heke99/localai", target_limit: 50 });
  });
});
