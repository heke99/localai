import type { SupabaseClient } from "@supabase/supabase-js";
import type { ImpactAnalysis, TaskAnalysis, VerificationPlan, VerificationReport } from "@div3rsa/agent-runtime";
import type { Database, Json } from "@div3rsa/db";
import type { PreparedRepositoryWorkspace } from "./repository-runtime";
import type { AgentQueue, AgentResourceContext, ClaimedRun } from "./processor";
import { chunk, impactNodePayload, repositoryGraph, verificationResultPayload } from "./observability";

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

function asJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json;
}

function requiredId(value: unknown, errorCode: string): string {
  if (typeof value !== "string" || !/^[0-9a-f-]{36}$/i.test(value)) throw new Error(errorCode);
  return value;
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
    const { error } = await this.client.rpc("worker_record_agent_step", { target_run_id: runId, step_kind: kind, step_status: status, summary, state: asJson(state) });
    if (error) throw error;
  }

  async recordRunIntelligence(runId: string, task: TaskAnalysis, skills: string[]): Promise<void> {
    const { error } = await this.client.rpc("worker_record_run_intelligence", {
      target_run_id: runId,
      target_task_analysis: asJson(task),
      target_skills: asJson(skills)
    });
    if (error) throw error;
  }

  async recordRepositoryIndex(runId: string, phase: "baseline" | "post_change", verificationRound: number | null, workspace: PreparedRepositoryWorkspace): Promise<string> {
    const { data, error } = await this.client.rpc("worker_begin_repository_index", {
      target_run_id: runId,
      target_resource_id: workspace.resourceId,
      target_phase: phase,
      target_verification_round: verificationRound,
      target_repository: workspace.repository,
      target_ref: workspace.ref,
      target_revision_sha: workspace.revision,
      target_content_revision_hash: workspace.index.revisionHash,
      target_project_profile: asJson(workspace.index.projectProfile)
    });
    if (error) throw error;
    const indexId = requiredId(data, "repository_index_id_invalid");
    const graph = repositoryGraph(workspace);
    const nodeBatches = chunk(graph.nodes);
    const edgeBatches = chunk(graph.edges);
    try {
      const batches = Math.max(nodeBatches.length, edgeBatches.length);
      for (let batch = 0; batch < batches; batch += 1) {
        const { error: appendError } = await this.client.rpc("worker_append_repository_index", {
          target_index_id: indexId,
          target_nodes: asJson(nodeBatches[batch] ?? []),
          target_edges: asJson(edgeBatches[batch] ?? [])
        });
        if (appendError) throw appendError;
      }
      const counts = {
        files: workspace.index.files.length,
        symbols: workspace.index.symbols.length,
        imports: workspace.index.edges.length,
        routes: workspace.index.routes.length,
        databaseEntities: workspace.index.databaseEntities.length,
        tests: workspace.index.tests.length,
        nodes: graph.nodes.length,
        edges: graph.edges.length
      };
      const { error: finishError } = await this.client.rpc("worker_finish_repository_index", { target_index_id: indexId, target_complete: workspace.complete, target_counts: asJson(counts) });
      if (finishError) throw finishError;
      return indexId;
    } catch (error) {
      await this.client.rpc("worker_finish_repository_index", { target_index_id: indexId, target_complete: false, target_counts: asJson({ persistenceError: true }) });
      throw error;
    }
  }

  async recordImpactAnalysis(runId: string, verificationRound: number, repositoryIndexId: string | null, impact: ImpactAnalysis): Promise<string> {
    const { data, error } = await this.client.rpc("worker_record_impact_analysis", {
      target_run_id: runId,
      target_verification_round: verificationRound,
      target_repository_index_id: repositoryIndexId,
      target_risk: impact.risk,
      target_verification_hints: asJson(impact.verificationHints),
      target_nodes: asJson(impactNodePayload(impact))
    });
    if (error) throw error;
    return requiredId(data, "impact_analysis_id_invalid");
  }

  async recordVerificationRun(runId: string, verificationRound: number, repositoryIndexId: string | null, impactAnalysisId: string | null, plan: VerificationPlan, report: VerificationReport, reviewer: { passed: boolean; reason: string }): Promise<string> {
    const status = report.passed ? "passed" : report.results.some((result) => result.status === "blocked") ? "blocked" : "failed";
    const { data, error } = await this.client.rpc("worker_record_verification_run", {
      target_run_id: runId,
      target_verification_round: verificationRound,
      target_repository_index_id: repositoryIndexId,
      target_impact_analysis_id: impactAnalysisId,
      target_status: status,
      target_plan: asJson(plan),
      target_blockers: asJson(report.unresolvedBlockers),
      target_reviewer: asJson(reviewer),
      target_results: asJson(verificationResultPayload(plan, report))
    });
    if (error) throw error;
    return requiredId(data, "verification_run_id_invalid");
  }

  async complete(run: ClaimedRun, output: { content: string; modelVersionId: string; usage: Record<string, number> }): Promise<void> {
    const { error } = await this.client.rpc("worker_complete_agent_run", { target_run_id: run.runId, target_job_id: run.jobId, output_content: output.content, usage: asJson(output.usage) });
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
