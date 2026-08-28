import { executionPolicyFor, type ImpactAnalysis, type TaskAnalysis, type VerificationPlan, type VerificationReport } from "@div3rsa/agent-runtime";
import type { PreparedRepositoryWorkspace } from "../repository-runtime";
import type { AgentQueue, ClaimedRun } from "../processor";
import type { AgentKernelConfig } from "./config";
import { AgentKernelShadowTelemetry } from "./shadow-telemetry";
import type { AgentKernelShadowProbeRunner } from "./shadow-probe";

type IntelligenceSnapshot = { task: TaskAnalysis; skills: string[] };

export class AgentKernelShadowQueue implements AgentQueue {
  private readonly claimedRuns = new Map<string, ClaimedRun>();
  private readonly intelligence = new Map<string, IntelligenceSnapshot>();
  private readonly telemetry: AgentKernelShadowTelemetry;

  constructor(
    private readonly inner: AgentQueue,
    config: AgentKernelConfig,
    private readonly probes?: AgentKernelShadowProbeRunner
  ) {
    this.telemetry = new AgentKernelShadowTelemetry(config, {
      record: async (runId, state) => {
        await this.inner.step(runId, "agent_kernel_shadow", "observed", "Agent Kernel V2 shadow observation", { agentKernelV2: state });
      }
    });
  }

  async claim(workerId: string): Promise<ClaimedRun | null> {
    const run = await this.inner.claim(workerId);
    if (run) this.claimedRuns.set(run.runId, run);
    return run;
  }

  async step(runId: string, kind: string, status: string, summary: string, state?: Record<string, unknown>): Promise<void> {
    await this.inner.step(runId, kind, status, summary, state);
  }

  async stream(runId: string, delta: string, reset?: boolean): Promise<void> {
    await this.inner.stream(runId, delta, reset);
  }

  async recordRunIntelligence(runId: string, task: TaskAnalysis, skills: string[]): Promise<void> {
    await this.inner.recordRunIntelligence(runId, task, skills);
    this.intelligence.set(runId, { task, skills: [...skills] });
    const run = this.claimedRuns.get(runId);
    if (!run) return;

    const policy = executionPolicyFor(task);
    await this.telemetry.observe({
      runId,
      conversationId: null,
      mode: run.mode,
      modelAlias: run.modelAlias,
      objective: run.prompt,
      task,
      availableToolNames: policy.allowedToolGroups,
      requestedAt: new Date().toISOString()
    }, {
      executionTier: policy.tier,
      repoDepth: policy.repoDepth,
      verificationRounds: policy.verificationRounds,
      selectedSkills: [...skills],
      allowedToolGroups: [...policy.allowedToolGroups]
    });
  }

  async recordRepositoryIndex(runId: string, phase: "baseline" | "post_change", verificationRound: number | null, workspace: PreparedRepositoryWorkspace): Promise<string> {
    return this.inner.recordRepositoryIndex(runId, phase, verificationRound, workspace);
  }

  async recordImpactAnalysis(runId: string, verificationRound: number, repositoryIndexId: string | null, impact: ImpactAnalysis): Promise<string> {
    return this.inner.recordImpactAnalysis(runId, verificationRound, repositoryIndexId, impact);
  }

  async recordVerificationRun(runId: string, verificationRound: number, repositoryIndexId: string | null, impactAnalysisId: string | null, plan: VerificationPlan, report: VerificationReport, reviewer: { passed: boolean; reason: string }): Promise<string> {
    return this.inner.recordVerificationRun(runId, verificationRound, repositoryIndexId, impactAnalysisId, plan, report, reviewer);
  }

  private launchProbe(run: ClaimedRun, output: { content: string }): void {
    const intelligence = this.intelligence.get(run.runId);
    if (!this.probes || !intelligence) return;
    void this.probes.run({
      runId: run.runId,
      requestId: run.requestId,
      modelAlias: run.modelAlias,
      prompt: run.prompt,
      baselineAnswer: output.content,
      task: intelligence.task,
      selectedSkills: intelligence.skills
    }).then(async (outcome) => {
      if (outcome.status !== "completed") return;
      await this.inner.step(run.runId, "agent_kernel_shadow_probe", "observed", "Agent Kernel V2 sampled model probe", {
        agentKernelV2Probe: outcome.observation
      });
    }).catch(() => undefined);
  }

  async complete(run: ClaimedRun, output: { content: string; modelVersionId: string; usage: Record<string, number> }): Promise<void> {
    this.launchProbe(run, output);
    try {
      await this.inner.complete(run, output);
    } finally {
      this.claimedRuns.delete(run.runId);
      this.intelligence.delete(run.runId);
    }
  }

  async fail(run: ClaimedRun, errorCode: string, retryable: boolean): Promise<void> {
    try {
      await this.inner.fail(run, errorCode, retryable);
    } finally {
      this.claimedRuns.delete(run.runId);
      this.intelligence.delete(run.runId);
    }
  }

  async isCancelled(runId: string): Promise<boolean> {
    const cancelled = await this.inner.isCancelled(runId);
    if (cancelled) {
      this.claimedRuns.delete(runId);
      this.intelligence.delete(runId);
    }
    return cancelled;
  }
}
