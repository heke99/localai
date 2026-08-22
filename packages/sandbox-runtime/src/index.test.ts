import { describe, expect, it, vi } from "vitest";
import { DockerSandboxBackend } from "./index";

describe("docker sandbox backend", () => {
  it("builds an argument-safe, non-root, bounded, default-deny execution", async () => {
    const run = vi.fn(async (_binary: string, _args: string[], _options: { timeoutMs: number }) => ({ exitCode: 0, stdout: "ok", stderr: "", durationMs: 4 }));
    const backend = new DockerSandboxBackend(run);
    await backend.execute({ runId: "run-1", profile: "code", imageDigest: "example@sha256:" + "a".repeat(64), command: ["npm", "test"], workspacePath: "/tmp/work", cpuLimit: 2, memoryMb: 2048, ttlSeconds: 60, network: { default: "deny", allowHosts: [], allowCidrs: [] } });
    const [binary, args] = run.mock.calls[0]!;
    expect(binary).toBe("docker");
    expect(args).toEqual(expect.arrayContaining(["--network", "none", "--user", "65532:65532", "--read-only", "--pids-limit", "256"]));
    expect(args.at(-2)).toBe("npm");
    expect(args.at(-1)).toBe("test");
  });
});
