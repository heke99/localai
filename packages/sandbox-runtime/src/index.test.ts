import { describe, expect, it, vi } from "vitest";
import { DockerSandboxBackend, ExternalSandboxBackend } from "./index";

const baseRequest = {
  runId: "run-1",
  profile: "code" as const,
  command: ["npm", "test"],
  workspacePath: "/tmp/work",
  cpuLimit: 2,
  memoryMb: 2048,
  ttlSeconds: 60,
  network: { default: "deny" as const, allowHosts: [], allowCidrs: [] }
};

describe("external sandbox backend", () => {
  it("uses the configured hardened runner without requiring Docker or an image digest", async () => {
    const run = vi.fn(async (_binary: string, _args: string[], _options: { timeoutMs: number }) => ({ exitCode: 0, stdout: "ok", stderr: "", durationMs: 4 }));
    const backend = new ExternalSandboxBackend(run, "/usr/local/bin/div3rsa-sandbox-runner");

    await backend.execute({
      ...baseRequest,
      profile: "lab",
      network: { default: "deny", allowHosts: ["target.example"], allowCidrs: ["203.0.113.8/32"] }
    });

    const [binary, args, options] = run.mock.calls[0]!;
    expect(binary).toBe("/usr/local/bin/div3rsa-sandbox-runner");
    expect(args).toEqual(expect.arrayContaining([
      "exec",
      "--profile", "lab",
      "--network-default", "deny",
      "--allow-host", "target.example",
      "--allow-cidr", "203.0.113.8/32",
      "--",
      "npm", "test"
    ]));
    expect(args).not.toContain("docker");
    expect(options).toEqual({ timeoutMs: 60_000 });
  });

  it("never treats the agent command as the host executable", async () => {
    const run = vi.fn(async (_binary: string, _args: string[], _options: { timeoutMs: number }) => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 1 }));
    const backend = new ExternalSandboxBackend(run);
    await backend.execute(baseRequest);
    expect(run.mock.calls[0]?.[0]).toBe("div3rsa-sandbox-runner");
  });
});

describe("docker sandbox backend", () => {
  it("remains available only as an explicit compatibility backend", async () => {
    const run = vi.fn(async (_binary: string, _args: string[], _options: { timeoutMs: number }) => ({ exitCode: 0, stdout: "ok", stderr: "", durationMs: 4 }));
    const backend = new DockerSandboxBackend(run);
    await backend.execute({ ...baseRequest, imageDigest: "example@sha256:" + "a".repeat(64) });
    const [binary, args] = run.mock.calls[0]!;
    expect(binary).toBe("docker");
    expect(args).toEqual(expect.arrayContaining(["--network", "none", "--user", "65532:65532", "--read-only", "--pids-limit", "256"]));
    expect(args).toContain("type=bind,src=/tmp/work,dst=/repo,readonly");
    expect(args.some((value) => value.startsWith("/workspace:rw,nosuid,size=") && value.endsWith("m,mode=1777"))).toBe(true);
    expect(args.slice(-6)).toEqual(["sh", "-lc", 'cp -R /repo/. /workspace && exec "$@"', "div3rsa-sandbox", "npm", "test"]);
  });
});
