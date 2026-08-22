import { validateSandboxRequest, type SandboxRequest } from "@div3rsa/platform-core";

export interface SandboxExecution extends SandboxRequest { imageDigest: string; command: string[]; workspacePath: string }
export interface ExecutionResult { exitCode: number; stdout: string; stderr: string; durationMs: number }
export type CommandRunner = (binary: string, args: string[], options: { timeoutMs: number }) => Promise<ExecutionResult>;

export class DockerSandboxBackend {
  constructor(private readonly run: CommandRunner) {}
  async execute(request: SandboxExecution): Promise<ExecutionResult> {
    validateSandboxRequest(request);
    if (!/^[a-z0-9./_-]+@sha256:[a-f0-9]{64}$/i.test(request.imageDigest)) throw new Error("sandbox_image_digest_required");
    if (!request.workspacePath.startsWith("/") || request.command.length === 0 || request.command.some((part) => part.includes("\0"))) throw new Error("invalid_sandbox_execution");
    if (request.network.allowHosts.length || request.network.allowCidrs.length) throw new Error("docker_backend_allowlist_proxy_required");
    const args = ["run", "--rm", "--name", `div3rsa-${request.runId.replace(/[^a-z0-9_.-]/gi, "-")}`, "--network", "none", "--user", "65532:65532", "--read-only", "--pids-limit", "256", "--cpus", String(request.cpuLimit), "--memory", `${request.memoryMb}m`, "--security-opt", "no-new-privileges", "--cap-drop", "ALL", "--tmpfs", "/tmp:rw,noexec,nosuid,size=256m", "--mount", `type=bind,src=${request.workspacePath},dst=/workspace`, "--workdir", "/workspace", request.imageDigest, ...request.command];
    return this.run("docker", args, { timeoutMs: request.ttlSeconds * 1000 });
  }
}
