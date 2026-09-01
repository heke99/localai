import type { ImpactAnalysis, TaskAnalysis, VerificationPlan, VerificationReport } from "@div3rsa/agent-runtime";
import { buildTrajectory, digestTrajectoryValue, trajectoryEligibleForTraining } from "./trajectory";
import { proceduralMemory, promoteVerifiedExperience } from "./verified-experience";
import type { SupabaseAgentKernelStore } from "./store";
import type { AgentQueue, ClaimedRun } from "../processor";
import type { PreparedRepositoryWorkspace } from "../repository-runtime";

interface RunLearningState {
  task: TaskAnalysis | null;
  skills: string[];
  report: VerificationReport | null;
  reviewer: { passed: boolean; reason: string } | null;
}

const TEST_CHECK_KINDS = new Set(["targeted-tests", "unit-tests", "integration-tests"]);

function learningScope(run: ClaimedRun): string {
  const repository = run.resourceContext.find((resource) => resource.provider === "github" && resource.resourceType === "repository");
  return repository ? `repo:${repository.displayName.toLowerCase()}` : `mode:${run.mode}`;
}

function evidenceRefs(report: VerificationReport): string[] {
  return [...new Set(report.results.flatMap((result) => result.status === "passed"
    ? [`verification:${result.kind}`, ...(result.evidence ?? []).map((item) => `evidence:${digestTrajectoryValue(item)}`)]
    : []))].sort();
}

function structuralProcedure(task: TaskAnalysis, skills: string[], report: VerificationReport): string {
  const categories = task.categories.length ? task.categories.join(",") : "general";
  const selected = skills.length ? skills.join(",") : "none";
  const checks = report.results.filter((result) => result.status === "passed").map((result) => result.kind).join(",");
  return `Verified execution pattern: categories=${categories}; risk=${task.risk}; reasoning=${task.reasoningLevel}; skills=${selected}; passedChecks=${checks || "none"}.`;
}

function allRequiredTestsPassed(report: VerificationReport): boolean | undefined {
  const requiredTests = report.plan.checks.filter((check) => check.required && TEST_CHECK_KINDS.has(check.kind));
  if (!requiredTests.length) return undefined;
  const passed = new Set(report.results.filter((result) => result.status === "passed").map((result) => result.kind));
  return requiredTests.every((check) => passed.has(check.kind)) ? true : undefined;
}

/**
 * Persists only verification-derived structural learning signals. Raw prompts,
 * final answer text and hidden model reasoning are intentionally excluded.
 */
export class VerifiedLearningAgentQueue implements AgentQueue {
  private readonly state = new Map<string, RunLearningState>();

  constructor(
    private readonly base: AgentQueue,
    private readonly store: SupabaseAgentKernelStore,
    private readonly enabled: boolean,
    private readonly trainingEligibilityEnabled = false,
    private readonly logger: Pick<Console, "warn"> = console
  ) {}

  private runState(runId: string): RunLearningState {
    let state = this.state.get(runId);
    if (!state) {
      state = { task: null, skills: [], report: null, reviewer: null };
      this.state.set(runId, state);
    }
    return state;
  }

  claim(workerId: string) { return this.base.claim(workerId); }
  step(runId: string, kind: string, status: string, summary: string, state?: Record<string, unknown>) { return this.base.step(runId, kind, status, summary, state); }
  stream(runId: string, delta: string, reset?: boolean) { return this.base.stream(runId, delta, reset); }

  async recordRunIntelligence(runId: string, task: TaskAnalysis, skills: string[]): Promise<void> {
    if (this.enabled) {
      const state = this.runState(runId);
      state.task = structuredClone(task);
      state.skills = [...skills];
    }
    await this.base.recordRunIntelligence(runId, task, skills);
  }

  recordRepositoryIndex(runId: string, phase: "baseline" | "post_change", verificationRound: number | null, workspace: PreparedRepositoryWorkspace) {
    return this.base.recordRepositoryIndex(runId, phase, verificationRound, workspace);
  }

  recordImpactAnalysis(runId: string, verificationRound: number, repositoryIndexId: string | null, impact: ImpactAnalysis) {
    return this.base.recordImpactAnalysis(runId, verificationRound, repositoryIndexId, impact);
  }

  async recordVerificationRun(runId: string, verificationRound: number, repositoryIndexId: string | null, impactAnalysisId: string | null, plan: VerificationPlan, report: VerificationReport, reviewer: { passed: boolean; reason: string }): Promise<string> {
    if (this.enabled) {
      const state = this.runState(runId);
      state.report = structuredClone(report);
      state.reviewer = { ...reviewer };
    }
    return this.base.recordVerificationRun(runId, verificationRound, repositoryIndexId, impactAnalysisId, plan, report, reviewer);
  }

  private async persistVerifiedLearning(run: ClaimedRun, output: { modelVersionId: string; usage: Record<string, number> }): Promise<void> {
    const state = this.state.get(run.runId);
    if (!state?.task || !state.report?.passed || state.reviewer?.passed !== true) return;
    const report = state.report;
    const refs = evidenceRefs(report);
    if (!refs.length) return;
    const scope = learningScope(run);
    const procedure = structuralProcedure(state.task, state.skills, report);

    const procedural = proceduralMemory({ sourceRunId: run.runId, scope, procedure, evidenceRefs: refs, verified: true });
    if (procedural) await this.store.upsertMemory(procedural);

    const experience = promoteVerifiedExperience({
      sourceRunId: run.runId,
      scope,
      problem: `categories=${state.task.categories.join(",") || "general"}; risk=${state.task.risk}; verification=${state.task.verificationRequirements.join(",") || "standard"}`,
      successfulStrategy: `skills=${state.skills.join(",") || "none"}; passedChecks=${report.results.filter((result) => result.status === "passed").map((result) => result.kind).join(",")}`,
      evidenceRefs: refs,
      verificationPassed: true,
      regressionFree: true,
      sourceQuality: 1
    });
    if (experience) await this.store.upsertMemory(experience);

    const inputTokens = Number(output.usage.inputTokens ?? output.usage.input_tokens ?? 0) || 0;
    const outputTokens = Number(output.usage.outputTokens ?? output.usage.output_tokens ?? 0) || 0;
    const cachedTokens = Number(output.usage.cachedTokens ?? output.usage.cached_tokens ?? 0) || 0;
    const steps = report.results.map((result, index) => ({
      step: index + 1,
      reasoningMode: state.task!.reasoningLevel,
      tool: null,
      argumentsDigest: null,
      resultDigest: digestTrajectoryValue({ kind: result.kind, status: result.status, evidence: result.evidence ?? [] }),
      latencyMs: Math.max(0, result.durationMs ?? 0),
      tokens: index === report.results.length - 1 ? inputTokens + outputTokens : 0,
      cachedTokens: index === report.results.length - 1 ? cachedTokens : 0,
      sourceQuality: result.status === "passed" ? 1 : null,
      testsBefore: null,
      testsAfter: null,
      verificationResult: result.status === "passed" ? "passed" as const : result.status === "skipped" ? "skipped" as const : "failed" as const
    }));
    const trajectory = buildTrajectory({
      agentRunId: run.runId,
      modelVersion: output.modelVersionId,
      promptVersion: "agent-kernel-v2",
      steps,
      signals: {
        independentVerificationPassed: true,
        allTestsPass: allRequiredTestsPassed(report)
      }
    });
    await this.store.recordTrajectory(trajectory, this.trainingEligibilityEnabled && trajectoryEligibleForTraining(trajectory));
  }

  async complete(run: ClaimedRun, output: { content: string; modelVersionId: string; usage: Record<string, number> }): Promise<void> {
    await this.base.complete(run, output);
    if (this.enabled) {
      await this.persistVerifiedLearning(run, output).catch((error) => {
        this.logger.warn("[agent-kernel-learning] verified learning persistence failed", { runId: run.runId, error: error instanceof Error ? error.message : "unknown" });
      });
    }
    this.state.delete(run.runId);
  }

  async fail(run: ClaimedRun, errorCode: string, retryable: boolean): Promise<void> {
    await this.base.fail(run, errorCode, retryable);
    this.state.delete(run.runId);
  }

  isCancelled(runId: string) { return this.base.isCancelled(runId); }
}
