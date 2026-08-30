import { describe, expect, it, vi } from "vitest";
import { HttpSecurityToolExecutor, SecurityToolRuntime, type SecurityToolExecutor } from "./security-tool-runtime";
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

  it("injects selected skills into a run-specific capability plan and narrows JWT execution", async () => {
    const runtime = new SecurityToolRuntime(executor(), async () => ["authorized-pentest", "external-security:jwt-security"]);
    const definitions = await runtime.list(run({ prompt: "Verify JWT session security on the authorized API" }));
    const definition = definitions[0]!;
    const properties = definition.inputSchema.properties as Record<string, Record<string, unknown>>;
    expect(properties.tool.enum).toEqual(["http_probe", "tls_probe"]);
    expect(definition.description).toContain("PENTEST CAPABILITY PLAN V1");
    expect(definition.description).toContain("external-security:jwt-security");
    expect(definition.description).toContain("authenticated_session_state");
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

  it("rejects options that do not belong to the selected subtool before executor dispatch", async () => {
    const exec = executor();
    const runtime = new SecurityToolRuntime(exec);
    await expect(runtime.execute(run(), {
      id: "strict-options",
      name: "security_scan",
      input: { tool: "http_probe", target: "example.com", options: { rateLimit: 10 } }
    })).rejects.toThrow("invalid_security_option:rateLimit");
    expect(exec.execute).not.toHaveBeenCalled();
  });

  it("enforces the pre-model capability plan at execution time", async () => {
    const exec = executor();
    const runtime = new SecurityToolRuntime(exec);
    const jwtRun = run({ prompt: "Verify JWT session security on this authorized API" });
    await expect(runtime.execute(jwtRun, {
      id: "plan-violation",
      name: "security_scan",
      input: { tool: "template_scan", target: "https://example.com", options: { rateLimit: 10 } }
    })).rejects.toThrow("security_capability_plan_violation:template_scan");
    expect(exec.execute).not.toHaveBeenCalled();
  });

  it("turns operational executor failures into structured observations so the model can adapt", async () => {
    const exec: SecurityToolExecutor = { execute: vi.fn(async () => { throw new Error("security_executor_timeout"); }) };
    const runtime = new SecurityToolRuntime(exec);
    const output = await runtime.execute(run({ prompt: "Map the authorized web attack surface" }), {
      id: "timeout",
      name: "security_scan",
      input: { tool: "http_probe", target: "https://example.com", options: {} }
    }) as Record<string, unknown>;

    expect(output).toMatchObject({
      ok: false,
      status: "executor_error",
      errorCode: "security_executor_timeout",
      retryable: true,
      suggestedNextOperations: ["dns_lookup", "tls_probe"]
    });
    expect(output.evidence).toMatchObject({ kind: "security_tool_observation", status: "executor_error" });
  });

  it("preserves remote scope and policy denials as hard fail-closed errors", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: "security_private_resolution_out_of_scope" }), {
      status: 400,
      headers: { "content-type": "application/json" }
    }));
    const runtime = new SecurityToolRuntime(new HttpSecurityToolExecutor("http://executor/v1/execute", "token", fetcher as typeof fetch));

    await expect(runtime.execute(run(), {
      id: "remote-scope-denial",
      name: "security_scan",
      input: { tool: "http_probe", target: "https://example.com", options: {} }
    })).rejects.toThrow("security_private_resolution_out_of_scope");
  });

  it("normalizes noisy executor output into bounded evidence before it reaches model context", async () => {
    const exec: SecurityToolExecutor = {
      execute: vi.fn(async () => ({
        ok: true,
        exitCode: 0,
        durationMs: 20,
        stdout: "x".repeat(20_000),
        stderr: "y".repeat(8_000),
        findings: Array.from({ length: 150 }, (_, index) => ({ kind: "synthetic", title: `finding-${index}` })),
        auditId: "audit-long",
        capability: "synthetic:http"
      }))
    };
    const runtime = new SecurityToolRuntime(exec);
    const output = await runtime.execute(run(), {
      id: "bounded-output",
      name: "security_scan",
      input: { tool: "http_probe", target: "https://example.com", options: {} }
    }) as Record<string, any>;

    expect(output.stdout).toHaveLength(12_000);
    expect(output.stderr).toHaveLength(4_000);
    expect(output.findings).toHaveLength(100);
    expect(output.findingCount).toBe(150);
    expect(output.rawOutputTruncated).toBe(true);
    expect(output.evidence.raw.stdoutBytes).toBe(20_000);
  });
});
