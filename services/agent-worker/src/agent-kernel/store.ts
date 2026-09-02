import type { ModelMessage } from "@div3rsa/model-sdk";
import type { AgentMemoryRecord } from "./verified-experience";
import type { AgentTrajectory } from "./trajectory";
import type { VerifiedKernelCheckpoint } from "./checkpoint-rewind";
import type { VerifiedLearningExportEnvelope } from "./learning-export";

export type AgentKernelStoreRpcClient = {
  rpc<T>(name: string, args: Record<string, unknown>): Promise<{ data: T | null; error: { code?: string; message?: string } | null }>;
};

function rpcError(name: string, error: { code?: string; message?: string } | null): Error {
  return new Error(`${name}_failed:${error?.code ?? "unknown"}:${(error?.message ?? "").slice(0, 300)}`);
}

function parseConversationHistory(value: unknown): ModelMessage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || Array.isArray(entry) || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    if ((record.role !== "user" && record.role !== "assistant") || typeof record.content !== "string" || !record.content.trim()) return [];
    return [{ role: record.role, content: record.content } as ModelMessage];
  });
}

export class SupabaseAgentKernelStore {
  constructor(private readonly client: AgentKernelStoreRpcClient) {}

  async recordCheckpoint(checkpoint: VerifiedKernelCheckpoint, planDigest: string | null): Promise<void> {
    const { error } = await this.client.rpc<void>("worker_record_agent_kernel_checkpoint", {
      target_checkpoint_id: checkpoint.checkpointId,
      target_run_id: checkpoint.runId,
      target_label: checkpoint.label,
      target_snapshots: checkpoint.snapshots,
      target_plan_digest: planDigest,
      target_verification: checkpoint.verification,
      target_verified: checkpoint.verified
    });
    if (error) throw rpcError("agent_kernel_checkpoint_record", error);
  }

  async latestVerifiedCheckpoint(runId: string): Promise<Record<string, unknown> | null> {
    const { data, error } = await this.client.rpc<Record<string, unknown>>("worker_latest_verified_agent_kernel_checkpoint", { target_run_id: runId });
    if (error) throw rpcError("agent_kernel_checkpoint_read", error);
    return data;
  }

  async conversationHistory(requestId: string, limit = 60): Promise<ModelMessage[]> {
    const normalizedRequestId = requestId.trim();
    if (!normalizedRequestId) throw new Error("conversation_history_request_id_required");
    const { data, error } = await this.client.rpc<unknown>("worker_load_agent_conversation_history", {
      target_request_id: normalizedRequestId,
      target_limit: Math.max(0, Math.min(80, Math.floor(limit)))
    });
    if (error) throw rpcError("agent_conversation_history_read", error);
    return parseConversationHistory(data);
  }

  async upsertMemory(memory: AgentMemoryRecord): Promise<void> {
    const { error } = await this.client.rpc<void>("worker_upsert_agent_memory", {
      target_memory_id: memory.id,
      target_source_run_id: memory.sourceRunId,
      target_tier: memory.tier,
      target_scope: memory.scope,
      target_summary: memory.summary,
      target_evidence_refs: memory.evidenceRefs,
      target_verified: memory.verified,
      target_confidence: memory.confidence
    });
    if (error) throw rpcError("agent_memory_upsert", error);
  }

  async findMemories(scope: string, limit = 12): Promise<AgentMemoryRecord[]> {
    const { data, error } = await this.client.rpc<AgentMemoryRecord[]>("worker_find_agent_memories", {
      target_scope: scope,
      target_limit: Math.max(1, Math.min(50, Math.floor(limit)))
    });
    if (error) throw rpcError("agent_memory_read", error);
    return Array.isArray(data) ? data : [];
  }

  async recordTrajectory(trajectory: AgentTrajectory, trainingEligible: boolean): Promise<void> {
    const { error } = await this.client.rpc<void>("worker_record_agent_trajectory", {
      target_trajectory_id: trajectory.trajectoryId,
      target_run_id: trajectory.agentRunId,
      target_model_version: trajectory.modelVersion,
      target_prompt_version: trajectory.promptVersion,
      target_steps: trajectory.steps,
      target_user_feedback: trajectory.userFeedback,
      target_reward: trajectory.reward,
      target_training_eligible: trainingEligible
    });
    if (error) throw rpcError("agent_trajectory_record", error);
  }

  async exportVerifiedLearning(options: { minReward?: number; limit?: number; createdBefore: string }): Promise<VerifiedLearningExportEnvelope> {
    const minReward = Math.max(1, Math.min(1000, Math.floor(options.minReward ?? 1)));
    const limit = Math.max(1, Math.min(5000, Math.floor(options.limit ?? 500)));
    if (!Number.isFinite(Date.parse(options.createdBefore))) throw new Error("invalid_learning_export_cutoff");
    const { data, error } = await this.client.rpc<VerifiedLearningExportEnvelope>("worker_export_verified_agent_learning", {
      target_min_reward: minReward,
      target_limit: limit,
      target_created_before: options.createdBefore
    });
    if (error) throw rpcError("agent_learning_export", error);
    if (!data) throw new Error("agent_learning_export_failed:empty_response");
    return data;
  }
}