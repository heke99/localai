import type { ImpactAnalysis } from "./consequence-engine";
import type { TaskAnalysis } from "./task-analyzer";

export type VerificationCheckKind =
  | "response-integrity"
  | "current-information-evidence"
  | "diff-review"
  | "repository-intelligence"
  | "consequence-analysis"
  | "format"
  | "lint"
  | "typecheck"
  | "unit-tests"
  | "integration-tests"
  | "targeted-tests"
  | "database-invariants"
  | "browser-e2e"
  | "multi-viewport-review"
  | "accessibility"
  | "security-review"
  | "performance-regression"
  | "build"
  | "dependency-validation"
  | "dead-code-regression"
  | "deployment-health"
  | "independent-reviewer"
  | "completion-proof";

export interface VerificationCheck {
  kind: VerificationCheckKind;
  required: boolean;
  reason: string;
}

export interface VerificationPlan { checks: VerificationCheck[] }

export interface VerificationResult {
  kind: VerificationCheckKind;
  status: "passed" | "failed" | "skipped" | "blocked";
  summary: string;
  evidence?: string[];
  durationMs?: number;
}

export interface VerificationReport {
  plan: VerificationPlan;
  results: VerificationResult[];
  passed: boolean;
  unresolvedBlockers: string[];
}

export interface RepositoryVerificationEvidence {
  revision: string;
  complete: boolean;
  indexedFiles: number;
  branch?: string;
}

export interface VerificationContext {
  task: TaskAnalysis;
  impact?: ImpactAnalysis;
  output?: string;
  repository?: RepositoryVerificationEvidence;
}

export interface VerificationExecutor {
  run(check: VerificationCheck, context: VerificationContext): Promise<VerificationResult>;
}

const order: VerificationCheckKind[] = [
  "response-integrity", "current-information-evidence", "diff-review", "repository-intelligence", "consequence-analysis", "format", "lint", "typecheck", "unit-tests", "targeted-tests",
  "integration-tests", "database-invariants", "browser-e2e", "multi-viewport-review", "accessibility", "dependency-validation",
  "dead-code-regression", "security-review", "performance-regression", "build", "deployment-health", "independent-reviewer", "completion-proof"
];

function add(checks: Map<VerificationCheckKind, VerificationCheck>, kind: VerificationCheckKind, required: boolean, reason: string) {
  const existing = checks.get(kind);
  if (!existing || (required && !existing.required)) checks.set(kind, { kind, required, reason });
}

export function createVerificationPlan(task: TaskAnalysis, impact?: ImpactAnalysis): VerificationPlan {
  const checks = new Map<VerificationCheckKind, VerificationCheck>();
  const changed = Boolean(impact?.changed.length);
  const repositoryChanged = Boolean(impact?.changed.some((node) => ["file", "symbol", "route", "api", "test"].includes(node.kind)));
  add(checks, "response-integrity", true, "Every run must return a valid non-empty result.");
  if (task.requiresCurrentInformation) add(checks, "current-information-evidence", true, "Current or live claims must be grounded in deterministic live data or opened current sources.");

  if (changed) {
    add(checks, "diff-review", true, "Changed code must be reviewed as a final change set.");
    if (repositoryChanged) add(checks, "repository-intelligence", true, "Repository mutations require a complete index of the exact post-change revision.");
    add(checks, "consequence-analysis", true, "Observed changes require impact analysis before completion.");
    add(checks, "targeted-tests", true, "Affected tests must be selected from the impact set.");
    add(checks, "dependency-validation", true, "Dependency relationships must remain valid after code changes.");
    if (task.project.languages?.some((language) => ["typescript", "javascript"].includes(language)) || impact?.changed.some((node) => /\.[cm]?[jt]sx?$/.test(node.path ?? ""))) {
      add(checks, "typecheck", true, "Typed JavaScript/TypeScript changes must preserve type safety.");
    }
    add(checks, "independent-reviewer", task.risk !== "low", "Medium and higher risk changes require an independent review pass.");
    if (task.categories.includes("testing")) add(checks, "unit-tests", true, "Testing tasks must execute the relevant test layer.");
    if (task.requiresDatabase || impact?.affected.some((node) => ["database", "rpc", "policy"].includes(node.kind))) add(checks, "database-invariants", true, "Database changes must verify schema, policy and data invariants.");
    if (task.requiresBrowser) add(checks, "browser-e2e", true, "User-facing changes require a real browser flow.");
    if (task.categories.includes("design")) {
      add(checks, "multi-viewport-review", true, "UI changes require desktop, laptop, tablet and mobile review.");
      add(checks, "accessibility", true, "UI changes require accessibility verification.");
    }
    if (task.requiresSecurityReview) add(checks, "security-review", true, "High-risk or security-sensitive changes require a security review.");
    if (task.categories.includes("performance")) add(checks, "performance-regression", true, "Performance work must prove a measurable non-regression.");
    if (task.requiresDeployment || impact?.affected.some((node) => node.kind === "deployment")) {
      add(checks, "build", true, "Deployment changes require a successful production build.");
      add(checks, "deployment-health", true, "Deployment work requires post-deploy health evidence.");
    }
    if (task.categories.includes("refactor")) add(checks, "dead-code-regression", true, "Refactors must not create stale or unreachable code.");
  }

  for (const hint of impact?.verificationHints ?? []) {
    const supported = order.includes(hint as VerificationCheckKind) ? hint as VerificationCheckKind : null;
    if (supported) add(checks, supported, changed, "Required by consequence analysis.");
  }
  if ((impact?.affected.length ?? 0) > 12) add(checks, "integration-tests", true, "Broad impact requires integration coverage.");
  add(checks, "completion-proof", true, "Runtime completion is denied without explicit verification evidence.");
  return { checks: [...checks.values()].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind)) };
}

export async function executeVerificationPlan(plan: VerificationPlan, executor: VerificationExecutor, context: VerificationContext): Promise<VerificationReport> {
  const results: VerificationResult[] = [];
  for (const check of plan.checks) {
    if (check.kind === "completion-proof") {
      const failedBeforeProof = plan.checks.filter((candidate) => candidate.required && candidate.kind !== "completion-proof").some((candidate) => results.find((result) => result.kind === candidate.kind)?.status !== "passed");
      results.push({ kind: check.kind, status: failedBeforeProof ? "blocked" : "passed", summary: failedBeforeProof ? "Completion proof blocked by unresolved mandatory verification." : "All mandatory verification checks have passing evidence." });
      continue;
    }
    let result: VerificationResult;
    try { result = await executor.run(check, context); }
    catch (error) { result = { kind: check.kind, status: "failed", summary: error instanceof Error ? error.message : "verification_executor_failed" }; }
    if (result.kind !== check.kind) throw new Error(`verification_kind_mismatch:${check.kind}`);
    results.push(result);
  }
  const unresolvedBlockers = plan.checks.filter((check) => check.required).flatMap((check) => {
    const result = results.find((candidate) => candidate.kind === check.kind);
    return result?.status === "passed" ? [] : [`${check.kind}:${result?.status ?? "missing"}`];
  });
  return { plan, results, passed: unresolvedBlockers.length === 0, unresolvedBlockers };
}

export function assertCompletionAllowed(report: VerificationReport): void {
  if (!report.passed) throw new Error(`verification_gate_failed:${report.unresolvedBlockers.join(",")}`);
}

export function createResponseOnlyVerificationExecutor(): VerificationExecutor {
  return {
    async run(check, context) {
      if (check.kind === "response-integrity") {
        const ok = Boolean(context.output?.trim());
        return { kind: check.kind, status: ok ? "passed" : "failed", summary: ok ? "Model output is non-empty." : "Model output is empty." };
      }
      if (check.kind === "repository-intelligence") {
        const ok = context.repository?.complete === true && context.repository.indexedFiles > 0 && Boolean(context.repository.revision);
        return { kind: check.kind, status: ok ? "passed" : check.required ? "blocked" : "skipped", summary: ok ? `Repository revision ${context.repository!.revision} was fully indexed.` : "No complete repository revision evidence is configured." };
      }
      return { kind: check.kind, status: check.required ? "blocked" : "skipped", summary: "No execution evidence provider is configured for this verification check." };
    }
  };
}
