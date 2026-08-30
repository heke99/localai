import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { LinuxSecurityExecutor, bearerMatches, type SecurityExecutorRequest } from "./runtime";

function request(overrides: Partial<SecurityExecutorRequest> = {}): SecurityExecutorRequest {
  return {
    runId: "run-1",
    requestId: "request-1",
    traceId: "trace-1",
    tool: "http_probe",
    target: "https://example.com/health",
    timeoutMs: 20_000,
    executionClass: "passive",
    scope: { scopeId: "scope-1", allowHosts: ["example.com"], allowIpv4Cidrs: ["203.0.113.0/24"] },
    options: {},
    ...overrides
  };
}

function successfulSpawn(stdoutText = "HTTP/1.1 200 OK\n") {
  return vi.fn((_command: string, _args: readonly string[]) => {
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; pid: number; kill: ReturnType<typeof vi.fn> };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = 99_999_999;
    child.kill = vi.fn();
    queueMicrotask(() => {
      child.stdout.end(stdoutText);
      child.stderr.end();
      child.emit("close", 0);
    });
    return child as never;
  });
}

describe("LinuxSecurityExecutor", () => {
  it("executes an allowlisted passive operation without a shell", async () => {
    const spawnProcess = successfulSpawn();
    const executor = new LinuxSecurityExecutor({ resolveHost: async () => ["203.0.113.10"], spawnProcess: spawnProcess as never });
    const result = await executor.execute(request());
    expect(result.ok).toBe(true);
    expect(result.capability).toBe("curl:http_probe");
    expect(result.auditId).toBeTruthy();
    expect(spawnProcess).toHaveBeenCalledOnce();
    expect(spawnProcess.mock.calls[0]?.[0]).toBe("curl");
    expect(spawnProcess.mock.calls[0]?.[2]).toMatchObject({ shell: false });
  });

  it("denies targets outside the trusted scope before spawning", async () => {
    const spawnProcess = successfulSpawn();
    const executor = new LinuxSecurityExecutor({ resolveHost: async () => ["203.0.113.10"], spawnProcess: spawnProcess as never });
    await expect(executor.execute(request({ target: "https://evil-example.com" }))).rejects.toThrow("security_target_out_of_scope");
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("blocks DNS rebinding into link-local infrastructure", async () => {
    const spawnProcess = successfulSpawn();
    const executor = new LinuxSecurityExecutor({ resolveHost: async () => ["169.254.169.254"], spawnProcess: spawnProcess as never });
    await expect(executor.execute(request())).rejects.toThrow("security_target_blocked");
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("requires private DNS resolutions to also be CIDR-authorized", async () => {
    const executor = new LinuxSecurityExecutor({ resolveHost: async () => ["10.20.30.40"], spawnProcess: successfulSpawn() as never });
    await expect(executor.execute(request())).rejects.toThrow("security_private_resolution_out_of_scope");
  });

  it("rejects execution-class downgrade attempts", async () => {
    const executor = new LinuxSecurityExecutor({ resolveHost: async () => ["203.0.113.10"], spawnProcess: successfulSpawn() as never });
    await expect(executor.execute(request({ tool: "port_scan", executionClass: "passive" }))).rejects.toThrow("security_execution_class_mismatch");
  });

  it("rejects arbitrary tool names and invalid port options", async () => {
    const executor = new LinuxSecurityExecutor({ resolveHost: async () => ["203.0.113.10"], spawnProcess: successfulSpawn() as never });
    await expect(executor.execute(request({ tool: "bash" }))).rejects.toThrow("security_tool_not_allowlisted");
    await expect(executor.execute(request({ tool: "port_scan", executionClass: "active", options: { ports: [22, 0] } }))).rejects.toThrow("invalid_security_option:ports");
  });
});

describe("bearerMatches", () => {
  it("accepts the exact bearer token only", () => {
    expect(bearerMatches("Bearer secret", "secret")).toBe(true);
    expect(bearerMatches("Bearer wrong", "secret")).toBe(false);
    expect(bearerMatches(undefined, "secret")).toBe(false);
  });
});
