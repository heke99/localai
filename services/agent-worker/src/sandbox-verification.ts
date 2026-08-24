import { execFile } from "node:child_process";
import type { VerificationCheck, VerificationContext, VerificationResult } from "@div3rsa/agent-runtime";
import { DockerSandboxBackend, type CommandRunner, type ExecutionResult } from "@div3rsa/sandbox-runtime";
import type { PreparedRepositoryWorkspace } from "./repository-runtime";

interface PackageManifest {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface PlannedCommand { binary: string; args: string[]; label: string }

function defaultCommandRunner(binary: string, args: string[], options: { timeoutMs: number }): Promise<ExecutionResult> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    execFile(binary, args, { timeout: options.timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "string" && (error as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new Error(`sandbox_runner_unavailable:${binary}`));
        return;
      }
      const exitCode = typeof (error as { code?: unknown } | null)?.code === "number" ? (error as { code: number }).code : error ? 1 : 0;
      resolve({ exitCode, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), durationMs: Date.now() - started });
    });
  });
}

function rootPackage(workspace: PreparedRepositoryWorkspace): PackageManifest | null {
  const file = workspace.index.files.find((candidate) => candidate.path === "package.json");
  if (!file) return null;
  try {
    const parsed = JSON.parse(file.content) as PackageManifest;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function firstScript(manifest: PackageManifest | null, names: string[]) {
  for (const name of names) if (manifest?.scripts && typeof manifest.scripts[name] === "string") return name;
  return null;
}

function scriptCommand(packageManager: string, script: string, extra: string[] = []): PlannedCommand | null {
  if (packageManager === "npm") return { binary: "npm", args: ["run", script, ...(extra.length ? ["--", ...extra] : [])], label: `npm run ${script}${extra.length ? ` -- ${extra.join(" ")}` : ""}` };
  if (packageManager === "pnpm") return { binary: "pnpm", args: ["run", script, ...(extra.length ? ["--", ...extra] : [])], label: `pnpm run ${script}${extra.length ? ` -- ${extra.join(" ")}` : ""}` };
  if (packageManager === "yarn") return { binary: "yarn", args: [script, ...extra], label: `yarn ${script}${extra.length ? ` ${extra.join(" ")}` : ""}` };
  if (packageManager === "bun") return { binary: "bun", args: ["run", script, ...(extra.length ? ["--", ...extra] : [])], label: `bun run ${script}${extra.length ? ` -- ${extra.join(" ")}` : ""}` };
  return null;
}

function targetTests(context: VerificationContext) {
  if (!context.impact) return [];
  const byId = new Map(context.impact.affected.map((node) => [node.id, node]));
  return context.impact.testNodeIds.map((id) => byId.get(id)?.path).filter((value): value is string => Boolean(value));
}

function planCommand(check: VerificationCheck, workspace: PreparedRepositoryWorkspace, context: VerificationContext): PlannedCommand | null {
  const manifest = rootPackage(workspace);
  const manager = workspace.index.projectProfile.packageManager;
  let script: string | null = null;
  let extra: string[] = [];

  if (check.kind === "typecheck") script = firstScript(manifest, ["typecheck", "check:types", "types"]);
  else if (check.kind === "lint") script = firstScript(manifest, ["lint", "check:lint"]);
  else if (check.kind === "format") script = firstScript(manifest, ["format:check", "check:format"]);
  else if (check.kind === "build") script = firstScript(manifest, ["build"]);
  else if (check.kind === "unit-tests") script = firstScript(manifest, ["test:unit", "unit", "test"]);
  else if (check.kind === "integration-tests") script = firstScript(manifest, ["test:integration", "integration", "test"]);
  else if (check.kind === "targeted-tests") {
    script = firstScript(manifest, ["test", "test:unit"]);
    extra = targetTests(context).slice(0, 40);
  }
  else if (check.kind === "browser-e2e") script = firstScript(manifest, ["test:e2e", "e2e", "playwright"]);
  else if (check.kind === "dead-code-regression") script = firstScript(manifest, ["dead-code", "check:dead-code", "knip"]);
  else if (check.kind === "security-review") script = firstScript(manifest, ["security", "check:security"]);
  else if (check.kind === "dependency-validation") script = firstScript(manifest, ["typecheck", "check:types", "build"]);

  return script ? scriptCommand(manager, script, extra) : null;
}

export class SandboxVerificationRuntime {
  private readonly backend: DockerSandboxBackend;
  private readonly cache = new Map<string, Promise<ExecutionResult>>();

  constructor(private readonly imageDigest: string | null, runner: CommandRunner = defaultCommandRunner) {
    this.backend = new DockerSandboxBackend(runner);
  }

  async run(check: VerificationCheck, context: VerificationContext, workspace: PreparedRepositoryWorkspace | null): Promise<VerificationResult | null> {
    if (!workspace) return null;
    const command = planCommand(check, workspace, context);
    if (!command) return null;
    if (!this.imageDigest) return { kind: check.kind, status: check.required ? "blocked" : "skipped", summary: "Sandbox image digest is not configured." };

    const key = `${workspace.revision}:${command.binary}:${command.args.join("\u0000")}`;
    let pending = this.cache.get(key);
    if (!pending) {
      pending = this.backend.execute({
        runId: `${workspace.resourceId}-${check.kind}`,
        profile: check.kind === "browser-e2e" ? "browser" : "code",
        cpuLimit: check.kind === "browser-e2e" ? 4 : 6,
        memoryMb: check.kind === "browser-e2e" ? 8192 : 12288,
        ttlSeconds: check.kind === "browser-e2e" ? 1200 : 900,
        network: { default: "deny", allowHosts: [], allowCidrs: [] },
        imageDigest: this.imageDigest,
        command: [command.binary, ...command.args],
        workspacePath: workspace.workspacePath
      });
      this.cache.set(key, pending);
    }

    try {
      const result = await pending;
      const evidence = [`sandbox:${workspace.revision}`, `command:${command.label}`, `exit:${result.exitCode}`];
      if (result.exitCode === 0) return { kind: check.kind, status: "passed", summary: `${command.label} passed in isolated sandbox.`, evidence, durationMs: result.durationMs };
      const detail = (result.stderr || result.stdout).trim().slice(0, 1200);
      return { kind: check.kind, status: "failed", summary: `${command.label} failed in isolated sandbox${detail ? `: ${detail}` : "."}`, evidence, durationMs: result.durationMs };
    } catch (error) {
      return { kind: check.kind, status: check.required ? "blocked" : "skipped", summary: error instanceof Error ? error.message : "sandbox_execution_failed" };
    }
  }
}
