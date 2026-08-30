import { describe, expect, it, vi } from "vitest";
import { SecurityToolRuntime, type SecurityToolExecutor } from "./security-tool-runtime";
import type { ClaimedRun } from "./processor";

function run(overrides: Partial<ClaimedRun> = {}, capabilities = ["security.passive", "security.active"], metadata: Record<string, unknown> = { allowHosts: ["example.com"], allowIpv4Cidrs: ["203.0.113.0/24"] }): ClaimedRun {
  return {
    jobId: "job", runId: "run", mode: "lab", modelAlias: "general-prod", prompt: "authorized test", requestId: "req", traceId: "trace",
    resourceContext: [{ resourceId: "scope-1", connectionId: "scope", provider: "security", resourceType: "security_scope", externalResourceId: "scope-1", displayName: "Bug bounty scope", capabilities, metadata }],
    ...overrides
  } as ClaimedRun;
}

function executor(): SecurityToolExecutor & { execute: ReturnType<typeof vi.fn> } {
  return { execute: vi.fn(async () => ({ ok: true, exitCode: 0, durationMs: 12, findings: [], auditId: "audit-1" })) } as never;
}

describe("SecurityToolRuntime", () => {
  it("is visible only in lab mode with trusted scope and executor", async () => {
    const runtime = new SecurityToolRuntime(executor());
    expect(await runtime.list(run())).toHaveLength(1);
    expect(await runtime.list(run({ mode: "chat" }))).toEqual([]);
    expect(await new SecurityToolRuntime(null).list(run())).toEqual([]);
    expect(await runtime.list(run({ resourceContext: [] }))).toEqual([]);
  });

  it("allows exact and subdomain targets but rejects suffix lookalikes", async () => {
    const exec = executor();
    const runtime = new SecurityToolRuntime(exec);
    await runtime.execute(run(), { id: "1", name: "security_scan", input: { tool: "http_probe", target: "https://api.example.com/path" } });
    expect(exec.execute).toHaveBeenCalledOnce();
    await expect(runtime.execute(run(), { id: "2", name: "security_scan", input: { tool: "http_probe", target: "https://evil-example.com" } })).rejects.toThrow("security_target_out_of_scope");
  });

  it("enforces active capability separately", async () => {
    const runtime = new SecurityToolRuntime(executor());
    await expect(runtime.execute(run({}, ["security.passive"]), { id: "1", name: "security_scan", input: { tool: "port_scan", target: "example.com" } })).rejects.toThrow("security_active_capability_required");
  });

  it("blocks metadata and loopback even when explicitly present in scope", async () => {
    const runtime = new SecurityToolRuntime(executor());
    const metadata = { allowHosts: ["localhost"], allowIpv4Cidrs: ["127.0.0.0/8", "169.254.0.0/16"] };
    await expect(runtime.execute(run({}, ["security.active"], metadata), { id: "1", name: "security_scan", input: { tool: "port_scan", target: "127.0.0.1" } })).rejects.toThrow("security_target_blocked");
    await expect(runtime.execute(run({}, ["security.active"], metadata), { id: "2", name: "security_scan", input: { tool: "port_scan", target: "169.254.169.254" } })).rejects.toThrow("security_target_blocked");
  });

  it("supports authorized IPv4 CIDR targets", async () => {
    const exec = executor();
    const runtime = new SecurityToolRuntime(exec);
    await runtime.execute(run(), { id: "1", name: "security_scan", input: { tool: "port_scan", target: "203.0.113.42" } });
    expect(exec.execute).toHaveBeenCalledOnce();
    await expect(runtime.execute(run(), { id: "2", name: "security_scan", input: { tool: "port_scan", target: "203.0.114.42" } })).rejects.toThrow("security_target_out_of_scope");
  });

  it("never accepts arbitrary tool names or schemes", async () => {
    const runtime = new SecurityToolRuntime(executor());
    await expect(runtime.execute(run(), { id: "1", name: "security_scan", input: { tool: "bash", target: "example.com" } })).rejects.toThrow("security_tool_not_allowlisted");
    await expect(runtime.execute(run(), { id: "2", name: "security_scan", input: { tool: "http_probe", target: "file:///etc/passwd" } })).rejects.toThrow("invalid_security_target");
  });
});
