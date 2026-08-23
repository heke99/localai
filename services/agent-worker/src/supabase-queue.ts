import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@div3rsa/db";
import type { AgentQueue, AgentResourceContext, ClaimedRun } from "./processor";

function parseResourceContext(value: Json | undefined): AgentResourceContext[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || Array.isArray(entry) || typeof entry !== "object") return [];
    const item = entry as Record<string, Json | undefined>;
    if (typeof item.resourceId !== "string" || typeof item.connectionId !== "string" || typeof item.provider !== "string" || typeof item.resourceType !== "string" || typeof item.externalResourceId !== "string" || typeof item.displayName !== "string") return [];
    const capabilities = Array.isArray(item.capabilities) ? item.capabilities.filter((capability): capability is string => typeof capability === "string") : [];
    const metadata = item.metadata && !Array.isArray(item.metadata) && typeof item.metadata === "object" ? item.metadata as Record<string, unknown> : undefined;
    return [{ resourceId: item.resourceId, connectionId: item.connectionId, provider: item.provider, resourceType: item.resourceType, externalResourceId: item.externalResourceId, displayName: item.displayName, capabilities, metadata }];
  });
}

export class SupabaseAgentQueue implements AgentQueue {
  constructor(private readonly client: SupabaseClient<Database>) {}

  async claim(workerId: string): Promise<ClaimedRun | null> {
    const { data, error } = await this.client.rpc("worker_claim_agent_run", { worker_id: workerId });
    if (error) throw error;
    const row = data?.[0];
    if (!row) return null;
    const extended = row as typeof row & { resource_context?: Json };
    return { jobId: row.job_id, runId: row.run_id, mode: row.mode as ClaimedRun["mode"], modelAlias: row.model_alias as ClaimedRun["modelAlias"], prompt: row.prompt, requestId: row.request_id, traceId: row.trace_id, resourceContext: parseResourceContext(extended.resource_context) };
  }

  async step(runId: string, kind: string, status: string, summary: string, state: Record<string, unknown> = {}): Promise<void> {
    const { error } = await this.client.rpc("worker_record_agent_step", { target_run_id: runId, step_kind: kind, step_status: status, summary, state: state as Json });
    if (error) throw error;
  }

  async complete(run: ClaimedRun, output: { content: string; modelVersionId: string; usage: Record<string, number> }): Promise<void> {
    const { error } = await this.client.rpc("worker_complete_agent_run", { target_run_id: run.runId, target_job_id: run.jobId, output_content: output.content, usage: output.usage as Json });
    if (error) throw error;
  }

  async fail(run: ClaimedRun, errorCode: string, retryable: boolean): Promise<void> {
    const { error } = await this.client.rpc("worker_fail_agent_run", { target_run_id: run.runId, target_job_id: run.jobId, error_code: errorCode, retryable });
    if (error) throw error;
  }

  async isCancelled(runId: string): Promise<boolean> {
    const { data, error } = await this.client.rpc("worker_is_agent_run_cancelled", { target_run_id: runId });
    if (error) throw error;
    return data;
  }
}
