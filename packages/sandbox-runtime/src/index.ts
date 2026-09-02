import { validateSandboxRequest, type SandboxRequest } from "@div3rsa/platform-core";

export interface SandboxExecution extends SandboxRequest {
  imageDigest?: string;
  command: string[];
  workspacePath: string;
}

export interface ExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export type CommandRunner = (
  binary: string,
  args: string[],
  options: { timeoutMs: number }
) => Promise<ExecutionResult>;

export type SandboxBackendKind = "external" | "docker";

export interface SandboxBackend {
  readonly kind: SandboxBackendKind;
  execute(request: SandboxExecution): Promise<ExecutionResult>;
}

function validateExecution(request: SandboxExecution): void {
  validateSandboxRequest(request);
  if (!request.workspacePath.startsWith("/")) throw new Error("invalid_sandbox_execution");
  if (request.command.length === 0 || request.command.some((part) => !part || part.includes("\0"))) {
    throw new Error("invalid_sandbox_execution");
  }
}

function safeRunnerBinary(value: string): string {
  const binary = value.trim();
  if (!binary || !/^(?:\/[a-z0-9._/-]+|[a-z0-9._-]+)$/i.test(binary) || binary.includes("..")) {
    throw new Error("invalid_sandbox_runner_binary");
  }
  return binary;
}

/**
 * Provider-neutral sandbox adapter.
 *
 * The runner is an isolation boundary owned by deployment, not by the model.
 * It may be backed by Linux namespaces, a microVM, a remote runner or another
 * hardened implementation. The runner MUST enforce the supplied resource and
 * network policy and fail closed when it cannot do so.
 *
 * This adapter deliberately does not fall back to executing the requested
 * command directly on the agent host.
 */
export class ExternalSandboxBackend implements SandboxBackend {
  readonly kind = "external" as const;
  private readonly binary: string;

  constructor(private readonly run: CommandRunner, runnerBinary = "div3rsa-sandbox-runner") {
    this.binary = safeRunnerBinary(runnerBinary);
  }

  async execute(request: SandboxExecution): Promise<ExecutionResult> {
    validateExecution(request);
    const args = [
      "exec",
      "--run-id", request.runId,
      "--profile", request.profile,
      "--workspace", request.workspacePath,
      "--cpu-limit", String(request.cpuLimit),
      "--memory-mb", String(request.memoryMb),
      "--ttl-seconds", String(request.ttlSeconds),
      "--network-default", request.network.default,
      ...request.network.allowHosts.flatMap((host) => ["--allow-host", host]),
      ...request.network.allowCidrs.flatMap((cidr) => ["--allow-cidr", cidr]),
      "--",
      ...request.command
    ];
    return this.run(this.binary, args, { timeoutMs: request.ttlSeconds * 1000 });
  }
}

/**
 * Optional compatibility backend. Docker is never selected implicitly by the
 * runtime; deployments that still want it must opt in explicitly.
 */
export class DockerSandboxBackend implements SandboxBackend {
  readonly kind = "docker" as const;

  constructor(private readonly run: CommandRunner) {}

  async execute(request: SandboxExecution): Promise<ExecutionResult> {
    validateExecution(request);
    if (!request.imageDigest || !/^[a-z0-9./_-]+@sha256:[a-f0-9]{64}$/i.test(request.imageDigest)) {
      throw new Error("sandbox_image_digest_required");
    }
    if (request.network.allowHosts.length || request.network.allowCidrs.length) {
      throw new Error("docker_backend_allowlist_proxy_required");
    }
    const workspaceTmpfsMb = Math.max(256, Math.min(4096, Math.floor(request.memoryMb / 2)));
    const args = [
      "run", "--rm", "--name", `div3rsa-${request.runId.replace(/[^a-z0-9_.-]/gi, "-")}`,
      "--network", "none",
      "--user", "65532:65532",
      "--read-only",
      "--pids-limit", "256",
      "--cpus", String(request.cpuLimit),
      "--memory", `${request.memoryMb}m`,
      "--security-opt", "no-new-privileges",
      "--cap-drop", "ALL",
      "--tmpfs", "/tmp:rw,noexec,nosuid,size=256m,mode=1777",
      "--tmpfs", `/workspace:rw,nosuid,size=${workspaceTmpfsMb}m,mode=1777`,
      "--mount", `type=bind,src=${request.workspacePath},dst=/repo,readonly`,
      "--workdir", "/workspace",
      request.imageDigest,
      "sh", "-lc", 'cp -R /repo/. /workspace && exec "$@"', "div3rsa-sandbox", ...request.command
    ];
    return this.run("docker", args, { timeoutMs: request.ttlSeconds * 1000 });
  }
}
