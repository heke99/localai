import { describe, expect, it } from "vitest";
import { analyzeTask, createVerificationPlan, executeVerificationPlan } from "@div3rsa/agent-runtime";
import { buildRepositoryIndex } from "@div3rsa/repository-intelligence";
import type { PreparedRepositoryWorkspace } from "./repository-runtime";
import { createWorkerVerificationExecutor, impactFromRuntime, type WorkerToolTrace } from "./worker-verification";

function workspace(revision: string, files: Array<{ path: string; content: string }>): PreparedRepositoryWorkspace {
  return {
    resourceId: "repo-1",
    repository: "div3rsa/example",
    ref: "agent/fix-login",
    revision,
    complete: true,
    workspacePath: "/tmp/example",
    index: buildRepositoryIndex("repo-1", files)
  };
}

const baseline = workspace("a".repeat(40), [
  { path: "package.json", content: JSON.stringify({ scripts: { typecheck: "tsc --noEmit", test: "vitest run" }, devDependencies: { typescript: "5.9.3", vitest: "4.1.11" } }) },
  { path: "src/auth.ts", content: "export function verifyUser() { return false }" },
  { path: "src/session.ts", content: "import { verifyUser } from './auth'; export const session = () => verifyUser()" },
  { path: "app/api/login/route.ts", content: "import { session } from '../../../src/session'; export async function POST() { return session() }" },
  { path: "tests/login.test.ts", content: "import '../app/api/login/route'; test('login', () => {})" }
]);

const changed = workspace("b".repeat(40), [
  { path: "package.json", content: JSON.stringify({ scripts: { typecheck: "tsc --noEmit", test: "vitest run" }, devDependencies: { typescript: "5.9.3", vitest: "4.1.11" } }) },
  { path: "src/auth.ts", content: "export function verifyUser() { return true }" },
  { path: "src/session.ts", content: "import { verifyUser } from './auth'; export const session = () => verifyUser()" },
  { path: "app/api/login/route.ts", content: "import { session } from '../../../src/session'; export async function POST() { return session() }" },
  { path: "tests/login.test.ts", content: "import '../app/api/login/route'; test('login', () => {})" }
]);

const mutationTrace: WorkerToolTrace[] = [
  { sequence: 1, name: "github_write_file", input: { path: "src/auth.ts", branch: "agent/fix-login" }, output: { commit: { sha: "b".repeat(40) } } },
  { sequence: 2, name: "github_read_file", input: { path: "src/auth.ts", ref: "agent/fix-login" }, output: { sha: "file-sha" } }
];

describe("worker repository verification", () => {
  it("computes transitive callers and tests from the exact post-change graph", () => {
    const impact = impactFromRuntime(mutationTrace, baseline, changed);
    expect(impact).toBeDefined();
    expect(impact!.changed.map((node) => node.path)).toContain("src/auth.ts");
    expect(impact!.affected.map((node) => node.path)).toEqual(expect.arrayContaining(["src/session.ts", "app/api/login/route.ts", "tests/login.test.ts"]));
    expect(impact!.testNodeIds).toContain("file:tests/login.test.ts");
  });

  it("accepts fresh CI evidence only when it contains the post-change revision", async () => {
    const impact = impactFromRuntime(mutationTrace, baseline, changed)!;
    const task = analyzeTask("code", "Fix login", { languages: ["typescript"] });
    const plan = createVerificationPlan(task, impact);
    const trace: WorkerToolTrace[] = [
      ...mutationTrace,
      { sequence: 3, name: "github_read_actions", input: { branch: "agent/fix-login" }, output: { workflow_runs: [{ name: "verify typecheck test", conclusion: "success", head_sha: changed.revision }] } }
    ];
    const sandbox = { run: async () => null } as never;
    const report = await executeVerificationPlan(
      plan,
      createWorkerVerificationExecutor({ trace, reviewer: { passed: true, reason: "ok" }, workspace: changed, sandbox }),
      { task, impact, output: "fixed", repository: { revision: changed.revision, complete: true, indexedFiles: changed.index.files.length, branch: changed.ref } }
    );
    expect(report.results.find((result) => result.kind === "repository-intelligence")?.status).toBe("passed");
    expect(report.results.find((result) => result.kind === "typecheck")?.status).toBe("passed");
    expect(report.results.find((result) => result.kind === "targeted-tests")?.status).toBe("passed");
  });

  it("rejects CI success from a stale revision", async () => {
    const impact = impactFromRuntime(mutationTrace, baseline, changed)!;
    const task = analyzeTask("code", "Fix login", { languages: ["typescript"] });
    const plan = createVerificationPlan(task, impact);
    const trace: WorkerToolTrace[] = [
      ...mutationTrace,
      { sequence: 3, name: "github_read_actions", input: { branch: "agent/fix-login" }, output: { workflow_runs: [{ name: "verify typecheck test", conclusion: "success", head_sha: "c".repeat(40) }] } }
    ];
    const sandbox = { run: async () => null } as never;
    const report = await executeVerificationPlan(
      plan,
      createWorkerVerificationExecutor({ trace, reviewer: { passed: true, reason: "ok" }, workspace: changed, sandbox }),
      { task, impact, output: "fixed", repository: { revision: changed.revision, complete: true, indexedFiles: changed.index.files.length, branch: changed.ref } }
    );
    expect(report.passed).toBe(false);
    expect(report.unresolvedBlockers.some((blocker) => blocker.startsWith("typecheck:"))).toBe(true);
  });
});
