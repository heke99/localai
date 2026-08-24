import {
  analyzeConsequences,
  buildFileImpactGraph,
  type ConsequenceGraph,
  type ImpactAnalysis,
  type VerificationCheck,
  type VerificationContext,
  type VerificationExecutor,
  type VerificationResult
} from "@div3rsa/agent-runtime";
import { consequenceGraphInput } from "@div3rsa/repository-intelligence/consequence";
import type { PreparedRepositoryWorkspace } from "./repository-runtime";
import type { SandboxVerificationRuntime } from "./sandbox-verification";

export type WorkerToolTrace = { sequence: number; name: string; input: Record<string, unknown>; output: unknown };

const mutationTools = new Set([
  "github_write_file", "github_merge_pull_request",
  "supabase_write_database", "supabase_apply_migration", "supabase_deploy_function",
  "vercel_create_deployment", "vercel_rollback_deployment"
]);

export function hasMutation(trace: WorkerToolTrace[]) {
  return trace.some((item) => mutationTools.has(item.name));
}

export function hasRepositoryMutation(trace: WorkerToolTrace[]) {
  return trace.some((item) => item.name === "github_write_file" || item.name === "github_merge_pull_request");
}

export function repositoryMutationRef(trace: WorkerToolTrace[], fallback: string) {
  const write = [...trace].reverse().find((item) => item.name === "github_write_file" && typeof item.input.branch === "string" && item.input.branch);
  return write ? String(write.input.branch) : fallback;
}

function repositoryChangedFiles(before: PreparedRepositoryWorkspace | null, after: PreparedRepositoryWorkspace | null, trace: WorkerToolTrace[]) {
  const changed = new Set<string>();
  if (before && after && before.resourceId === after.resourceId) {
    const beforeHashes = new Map(before.index.files.map((file) => [file.path, file.hash]));
    const afterHashes = new Map(after.index.files.map((file) => [file.path, file.hash]));
    for (const [filePath, hash] of afterHashes) if (beforeHashes.get(filePath) !== hash) changed.add(filePath);
    for (const filePath of beforeHashes.keys()) if (!afterHashes.has(filePath)) changed.add(filePath);
  }
  for (const item of trace) if (item.name === "github_write_file" && typeof item.input.path === "string" && item.input.path) changed.add(item.input.path.replace(/^\.\//, ""));
  return [...changed].sort();
}

function syntheticMutationNodes(trace: WorkerToolTrace[]) {
  const items: Array<{ path: string; kind: ConsequenceGraph["nodes"][number]["kind"] }> = [];
  for (const item of trace) {
    if (item.name === "supabase_apply_migration") items.push({ path: `supabase/migrations/${String(item.input.name ?? "migration")}.sql`, kind: "database" });
    else if (item.name === "supabase_write_database") items.push({ path: `database:${String(item.input.resourceId ?? "unknown")}`, kind: "database" });
    else if (item.name === "supabase_deploy_function") items.push({ path: `edge-function:${String(item.input.name ?? "unknown")}`, kind: "service" });
    else if (item.name === "vercel_create_deployment" || item.name === "vercel_rollback_deployment") items.push({ path: `deployment:${String(item.input.resourceId ?? "unknown")}`, kind: "deployment" });
    else if (item.name === "github_merge_pull_request" && !items.some((entry) => entry.path.startsWith("pull-request:"))) items.push({ path: `pull-request:${String(item.input.pullNumber ?? "unknown")}`, kind: "workflow" });
  }
  return [...new Map(items.map((item) => [`${item.kind}:${item.path}`, item])).values()];
}

export function impactFromRuntime(trace: WorkerToolTrace[], before: PreparedRepositoryWorkspace | null, after: PreparedRepositoryWorkspace | null): ImpactAnalysis | undefined {
  const repoChanged = repositoryChangedFiles(before, after, trace);
  const synthetic = syntheticMutationNodes(trace);
  if (!repoChanged.length && !synthetic.length) return undefined;

  const base: ConsequenceGraph = after ? buildFileImpactGraph(consequenceGraphInput(after.index)) : { nodes: [], edges: [] };
  const nodeIds = new Set(base.nodes.map((node) => node.id));
  for (const filePath of repoChanged) {
    const id = `file:${filePath}`;
    if (!nodeIds.has(id)) {
      base.nodes.push({ id, kind: /(?:^|\/)(?:tests?|e2e)\/|\.(?:spec|test)\.[cm]?[jt]sx?$/i.test(filePath) ? "test" : "file", label: filePath, path: filePath });
      nodeIds.add(id);
    }
  }
  for (const item of synthetic) {
    const id = `change:${item.path}`;
    if (!nodeIds.has(id)) base.nodes.push({ id, kind: item.kind, label: item.path, path: item.path });
  }
  return analyzeConsequences(base, { files: [...repoChanged, ...synthetic.map((item) => item.path)] });
}

function serialized(value: unknown): string {
  try { return JSON.stringify(value).toLowerCase(); } catch { return ""; }
}

function latestMutationSequence(trace: WorkerToolTrace[]) {
  return trace.filter((item) => mutationTools.has(item.name)).reduce((max, item) => Math.max(max, item.sequence), 0);
}

function successfulActions(trace: WorkerToolTrace[], keywords: RegExp, revision?: string) {
  const cutoff = latestMutationSequence(trace);
  return trace.filter((item) => item.name === "github_read_actions" && item.sequence > cutoff).some((item) => {
    const text = serialized(item.output);
    const success = /"conclusion"\s*:\s*"success"/.test(text);
    const freshRevision = !revision || text.includes(revision.toLowerCase());
    return success && freshRevision && keywords.test(text);
  });
}

function successfulDeploymentRead(trace: WorkerToolTrace[]) {
  const cutoff = latestMutationSequence(trace);
  return trace.filter((item) => item.name === "vercel_read_deployments" && item.sequence > cutoff).some((item) => /"(?:state|ready_state|status)"\s*:\s*"(?:ready|ready_state|succeeded|success)"/.test(serialized(item.output)));
}

function reviewedChangedResources(trace: WorkerToolTrace[]) {
  const writes = trace.filter((item) => mutationTools.has(item.name));
  if (!writes.length) return true;
  return writes.every((write) => trace.some((candidate) => {
    if (candidate.sequence <= write.sequence) return false;
    if (write.name === "github_write_file") return candidate.name === "github_read_file" && candidate.input.path === write.input.path;
    if (write.name === "github_merge_pull_request") return candidate.name === "github_read_pull_requests" || candidate.name === "github_read_actions";
    if (write.name.startsWith("supabase_")) return candidate.name === "supabase_read_database" || candidate.name === "github_read_actions";
    return candidate.name === "vercel_read_deployments" || candidate.name === "vercel_read_logs";
  }));
}

export function createWorkerVerificationExecutor(input: {
  trace: WorkerToolTrace[];
  reviewer: { passed: boolean; reason: string };
  workspace: PreparedRepositoryWorkspace | null;
  sandbox: SandboxVerificationRuntime;
}): VerificationExecutor {
  const { trace, reviewer, workspace, sandbox } = input;
  return {
    async run(check: VerificationCheck, context: VerificationContext): Promise<VerificationResult> {
      const pass = (summary: string, evidence?: string[]): VerificationResult => ({ kind: check.kind, status: "passed", summary, evidence });
      const blocked = (summary: string): VerificationResult => ({ kind: check.kind, status: check.required ? "blocked" : "skipped", summary });
      if (check.kind === "response-integrity") return context.output?.trim() ? pass("Model output is non-empty.") : { kind: check.kind, status: "failed", summary: "Model output is empty." };
      if (check.kind === "repository-intelligence") {
        const evidence = context.repository;
        return evidence?.complete && evidence.indexedFiles > 0 && evidence.revision ? pass(`Complete repository revision ${evidence.revision} indexed.`, [`revision:${evidence.revision}`, `files:${evidence.indexedFiles}`]) : blocked("Exact post-change repository revision was not completely indexed.");
      }
      if (check.kind === "consequence-analysis") return context.impact ? pass(`Impact set computed with risk ${context.impact.risk}.`, context.impact.affected.map((node) => node.id).slice(0, 60)) : blocked("No observed change set was available for impact analysis.");
      if (check.kind === "diff-review") return reviewedChangedResources(trace) ? pass("Changed resources were re-read after mutation.") : blocked("At least one changed resource was not re-read after mutation.");
      if (check.kind === "independent-reviewer") return reviewer.passed ? pass(reviewer.reason) : blocked(`Independent reviewer rejected completion: ${reviewer.reason}`);

      const sandboxResult = await sandbox.run(check, context, workspace);
      if (sandboxResult?.status === "passed") return sandboxResult;

      const revision = workspace?.revision;
      if (check.kind === "database-invariants") return trace.some((item) => item.name === "supabase_read_database" && item.sequence > latestMutationSequence(trace)) || successfulActions(trace, /database|migration|verify|test|ci/, revision) ? pass("Fresh database verification evidence is present.") : sandboxResult ?? blocked("No fresh database invariant evidence is present.");
      if (check.kind === "deployment-health") return successfulDeploymentRead(trace) ? pass("Deployment provider reports a ready deployment after mutation.") : sandboxResult ?? blocked("No fresh deployment health evidence is present.");
      if (check.kind === "browser-e2e") return successfulActions(trace, /playwright|e2e|browser|verify|ci/, revision) ? pass("Successful browser/E2E evidence matches the post-change revision.") : sandboxResult ?? blocked("No successful browser/E2E evidence for the post-change revision is present.");
      if (check.kind === "multi-viewport-review" || check.kind === "accessibility") return successfulActions(trace, /playwright|visual|lighthouse|a11y|accessibility|verify|ci/, revision) ? pass("Successful UI verification evidence matches the post-change revision.") : sandboxResult ?? blocked("No successful UI/a11y evidence for the post-change revision is present.");
      if (check.kind === "security-review") return successfulActions(trace, /security|semgrep|trivy|audit|verify|ci/, revision) ? pass("Successful security evidence matches the post-change revision.") : sandboxResult ?? blocked("No successful security evidence for the post-change revision is present.");
      if (check.kind === "performance-regression") return successfulActions(trace, /performance|lighthouse|k6|load|verify|ci/, revision) ? pass("Successful performance evidence matches the post-change revision.") : sandboxResult ?? blocked("No successful performance evidence for the post-change revision is present.");
      if (check.kind === "dead-code-regression") return successfulActions(trace, /knip|dead.?code|verify|ci/, revision) ? pass("Successful dead-code evidence matches the post-change revision.") : sandboxResult ?? blocked("No successful dead-code regression evidence is present.");
      if (check.kind === "typecheck") return successfulActions(trace, /typecheck|typescript|verify|ci/, revision) ? pass("Successful typecheck evidence matches the post-change revision.") : sandboxResult ?? blocked("No successful typecheck evidence for the post-change revision is present.");
      if (["targeted-tests", "unit-tests", "integration-tests"].includes(check.kind)) return successfulActions(trace, /test|vitest|jest|verify|ci/, revision) ? pass("Successful test evidence matches the post-change revision.") : sandboxResult ?? blocked("No successful test evidence for the post-change revision is present.");
      if (check.kind === "build") return successfulActions(trace, /build|verify|ci/, revision) || successfulDeploymentRead(trace) ? pass("Successful build/deployment evidence matches the post-change state.") : sandboxResult ?? blocked("No successful build evidence for the post-change revision is present.");
      if (check.kind === "dependency-validation") return successfulActions(trace, /typecheck|build|test|verify|ci/, revision) ? pass("Successful dependency validation evidence matches the post-change revision.") : sandboxResult ?? blocked("No dependency validation evidence for the post-change revision is present.");
      if (check.kind === "format" || check.kind === "lint") return successfulActions(trace, /lint|format|verify|ci/, revision) ? pass("Successful lint/format evidence matches the post-change revision.") : sandboxResult ?? blocked("No lint/format evidence for the post-change revision is present.");
      return sandboxResult ?? blocked(`No evidence rule is configured for ${check.kind}.`);
    }
  };
}
