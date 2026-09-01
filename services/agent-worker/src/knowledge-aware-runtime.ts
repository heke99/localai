import type { ImpactAnalysis, TaskAnalysis, VerificationPlan, VerificationReport } from "@div3rsa/agent-runtime";
import type { PreparedRepositoryWorkspace } from "./repository-runtime";
import type { AgentQueue, ClaimedRun, PreparedSkills, WorkerSkillRuntime } from "./processor";
import { formatRetrievedKnowledgeContext, retrieveKnowledgeForRun, type KnowledgeRetrievalDependencies } from "./knowledge-retrieval";

export class RunTrackingAgentQueue implements AgentQueue {
  private activeRun: ClaimedRun | null = null;

  constructor(private readonly delegate: AgentQueue) {}

  currentRun(): ClaimedRun | null {
    return this.activeRun;
  }

  async claim(workerId: string): Promise<ClaimedRun | null> {
    const run = await this.delegate.claim(workerId);
    this.activeRun = run;
    return run;
  }

  step(runId: string, kind: string, status: string, summary: string, state?: Record<string, unknown>): Promise<void> {
    return this.delegate.step(runId, kind, status, summary, state);
  }

  stream(runId: string, delta: string, reset?: boolean): Promise<void> {
    return this.delegate.stream(runId, delta, reset);
  }

  recordRunIntelligence(runId: string, task: TaskAnalysis, skills: string[]): Promise<void> {
    return this.delegate.recordRunIntelligence(runId, task, skills);
  }

  recordRepositoryIndex(runId: string, phase: "baseline" | "post_change", verificationRound: number | null, workspace: PreparedRepositoryWorkspace): Promise<string> {
    return this.delegate.recordRepositoryIndex(runId, phase, verificationRound, workspace);
  }

  recordImpactAnalysis(runId: string, verificationRound: number, repositoryIndexId: string | null, impact: ImpactAnalysis): Promise<string> {
    return this.delegate.recordImpactAnalysis(runId, verificationRound, repositoryIndexId, impact);
  }

  recordVerificationRun(runId: string, verificationRound: number, repositoryIndexId: string | null, impactAnalysisId: string | null, plan: VerificationPlan, report: VerificationReport, reviewer: { passed: boolean; reason: string }): Promise<string> {
    return this.delegate.recordVerificationRun(runId, verificationRound, repositoryIndexId, impactAnalysisId, plan, report, reviewer);
  }

  async complete(run: ClaimedRun, output: { content: string; modelVersionId: string; usage: Record<string, number> }): Promise<void> {
    try {
      await this.delegate.complete(run, output);
    } finally {
      if (this.activeRun?.runId === run.runId) this.activeRun = null;
    }
  }

  async fail(run: ClaimedRun, errorCode: string, retryable: boolean): Promise<void> {
    try {
      await this.delegate.fail(run, errorCode, retryable);
    } finally {
      if (this.activeRun?.runId === run.runId) this.activeRun = null;
    }
  }

  isCancelled(runId: string): Promise<boolean> {
    return this.delegate.isCancelled(runId);
  }
}

export interface KnowledgeAwareSkillRuntimeOptions extends KnowledgeRetrievalDependencies {
  required?: boolean;
}

function requiredFromEnvironment(): boolean {
  const value = process.env.DIV3RSA_RAG_REQUIRED?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

export class KnowledgeAwareSkillRuntime implements WorkerSkillRuntime {
  constructor(
    private readonly base: WorkerSkillRuntime,
    private readonly queue: RunTrackingAgentQueue,
    private readonly options: KnowledgeAwareSkillRuntimeOptions = {}
  ) {}

  async prepare(mode: Parameters<WorkerSkillRuntime["prepare"]>[0], prompt: string): Promise<PreparedSkills> {
    const prepared = await this.base.prepare(mode, prompt);
    const run = this.queue.currentRun();
    if (!run) return prepared;

    try {
      const chunks = await retrieveKnowledgeForRun(run.runId, prompt, this.options);
      if (!chunks.length) return prepared;
      const context = formatRetrievedKnowledgeContext(chunks);
      await this.queue.step(run.runId, "knowledge", "completed", "Retrieved scoped hybrid-RAG evidence", {
        chunks: chunks.length,
        sourceIds: [...new Set(chunks.map((chunk) => chunk.sourceId))],
        topRrfScore: chunks[0]?.rrfScore ?? null
      });
      return {
        ...prepared,
        instructions: [prepared.instructions, context].filter(Boolean).join("\n\n")
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : "knowledge_retrieval_failed";
      await this.queue.step(run.runId, "knowledge", "blocked", "Scoped knowledge retrieval unavailable", { error: detail }).catch(() => undefined);
      if (this.options.required ?? requiredFromEnvironment()) throw error;
      return prepared;
    }
  }
}
