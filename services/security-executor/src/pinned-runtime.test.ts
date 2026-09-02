import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { LinuxSecurityExecutor, type SecurityExecutorRequest } from "./runtime";

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
  return vi.fn((_command: string, _args: readonly string[], _options?: unknown) => {
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; pid: number; kill: ReturnType<typeof vi.fn> };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = 99_999_997;
    child.kill = vi.fn();
    queueMicrotask(() => {
      child.stdout.end(stdoutText);
      child.stderr.end();
      child.emit("close", 0);
    });
    return child as never;
  });
}

function argsFor(spawnProcess: ReturnType<typeof successfulSpawn>): string[] {
  return [...(spawnProcess.mock.calls[0]?.[1] ?? [])];
}

describe("DNS-pinned native LinuxSecurityExecutor", () => {
  it("pins curl to the preflight IP while preserving the authorized hostname", async () => {
    const spawnProcess = successfulSpawn();
    const executor = new LinuxSecurityExecutor({ resolveHost: async () => ["203.0.113.10"], spawnProcess: spawnProcess as never });
    const result = await executor.execute(request());
    const args = argsFor(spawnProcess);

    expect(result.capability).toBe("curl:http_probe:dns_pinned");
    expect(spawnProcess.mock.calls[0]?.[0]).toBe("curl");
    expect(args).toEqual(expect.arrayContaining(["--resolve", "example.com:443:203.0.113.10", "https://example.com/health"]));
    expect(spawnProcess.mock.calls[0]?.[2]).toMatchObject({ shell: false });
  });

  it("connects openssl to the pinned IP and keeps SNI on the authorized host", async () => {
    const spawnProcess = successfulSpawn();
    const executor = new LinuxSecurityExecutor({ resolveHost: async () => ["203.0.113.11"], spawnProcess: spawnProcess as never });
    await executor.execute(request({ tool: "tls_probe" }));
    expect(argsFor(spawnProcess)).toEqual(expect.arrayContaining(["-connect", "203.0.113.11:443", "-servername", "example.com"]));
  });

  it("passes only the pinned address to nmap", async () => {
    const spawnProcess = successfulSpawn();
    const executor = new LinuxSecurityExecutor({ resolveHost: async () => ["203.0.113.12"], spawnProcess: spawnProcess as never });
    await executor.execute(request({ tool: "port_scan", executionClass: "active", options: { ports: [80, 443] } }));
    const args = argsFor(spawnProcess);
    expect(spawnProcess.mock.calls[0]?.[0]).toBe("nmap");
    expect(args.at(-1)).toBe("203.0.113.12");
    expect(args).not.toContain("example.com");
  });

  it("pins nuclei to the IP but preserves Host and TLS SNI", async () => {
    const spawnProcess = successfulSpawn();
    const executor = new LinuxSecurityExecutor({ resolveHost: async () => ["203.0.113.13"], spawnProcess: spawnProcess as never });
    await executor.execute(request({ tool: "template_scan", executionClass: "active", options: { rateLimit: 10 } }));
    const args = argsFor(spawnProcess);
    expect(spawnProcess.mock.calls[0]?.[0]).toBe("nuclei");
    expect(args).toEqual(expect.arrayContaining(["-u", "https://203.0.113.13/health", "-H", "Host: example.com", "-sni", "example.com", "-restrict-local-network-access", "-disable-redirects"]));
  });

  it("pins ffuf to the IP while preserving virtual host and SNI", async () => {
    const spawnProcess = successfulSpawn('{"results":[]}');
    const executor = new LinuxSecurityExecutor({
      resolveHost: async () => ["203.0.113.14"],
      spawnProcess: spawnProcess as never,
      wordlistPath: "/opt/wordlists/common.txt"
    });
    await executor.execute(request({ tool: "content_discovery", executionClass: "active", options: { rateLimit: 5 } }));
    const args = argsFor(spawnProcess);
    expect(spawnProcess.mock.calls[0]?.[0]).toBe("ffuf");
    expect(args).toEqual(expect.arrayContaining(["-u", "https://203.0.113.14/health/FUZZ", "-H", "Host: example.com", "-sni", "example.com"]));
  });

  it("fails closed before spawn when DNS resolves into blocked infrastructure", async () => {
    const spawnProcess = successfulSpawn();
    const executor = new LinuxSecurityExecutor({ resolveHost: async () => ["169.254.169.254"], spawnProcess: spawnProcess as never });
    await expect(executor.execute(request())).rejects.toThrow("security_target_blocked");
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("requires an explicit CIDR when an allowed hostname resolves to private IPv4", async () => {
    const spawnProcess = successfulSpawn();
    const executor = new LinuxSecurityExecutor({ resolveHost: async () => ["10.20.30.40"], spawnProcess: spawnProcess as never });
    await expect(executor.execute(request({ scope: { scopeId: "scope-1", allowHosts: ["example.com"], allowIpv4Cidrs: [] } }))).rejects.toThrow("security_private_resolution_out_of_scope");
    expect(spawnProcess).not.toHaveBeenCalled();
  });
});
