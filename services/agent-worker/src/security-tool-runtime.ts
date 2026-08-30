import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { ModelToolCall, ModelToolDefinition } from "@div3rsa/model-sdk";
import type { ClaimedRun, WorkerToolRuntime } from "./processor";

export type SecurityExecutionClass = "passive" | "active";

interface SecurityToolSpec {
  id: string;
  executionClass: SecurityExecutionClass;
  description: string;
  timeoutMs: number;
}

const TOOL_NAME = "security_scan";
const TOOL_SPECS: readonly SecurityToolSpec[] = [
  { id: "http_probe", executionClass: "passive", description: "Inspect HTTP(S) reachability, response metadata and headers for an authorized target.", timeoutMs: 20_000 },
  { id: "tls_probe", executionClass: "passive", description: "Inspect TLS certificate and negotiated protocol metadata for an authorized target.", timeoutMs: 20_000 },
  { id: "dns_lookup", executionClass: "passive", description: "Resolve DNS records for an authorized hostname.", timeoutMs: 15_000 },
  { id: "port_scan", executionClass: "active", description: "Run a bounded TCP port scan against an explicitly authorized target.", timeoutMs: 60_000 },
  { id: "template_scan", executionClass: "active", description: "Run bounded vulnerability templates against an explicitly authorized HTTP(S) target.", timeoutMs: 90_000 },
  { id: "content_discovery", executionClass: "active", description: "Run bounded web content discovery against an explicitly authorized HTTP(S) target.", timeoutMs: 60_000 }
] as const;

const TOOL_BY_ID = new Map(TOOL_SPECS.map((tool) => [tool.id, tool]));
const MAX_RESULT_BYTES = 512_000;

interface SecurityScope {
  scopeId: string;
  allowHosts: string[];
  allowIpv4Cidrs: string[];
  capabilities: Set<string>;
  readinessProof?: string;
}

export interface SecurityExecutorRequest {
  runId: string;
  requestId: string;
  traceId: string;
  tool: string;
  target: string;
  timeoutMs: number;
  executionClass: SecurityExecutionClass;
  scope: { scopeId: string; allowHosts: string[]; allowIpv4Cidrs: string[]; readinessProof?: string };
  options: Record<string, unknown>;
}

export interface SecurityExecutorResult {
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  stdout?: string;
  stderr?: string;
  findings?: unknown[];
  auditId?: string;
  capability?: string;
}

export interface SecurityToolExecutor {
  execute(request: SecurityExecutorRequest): Promise<SecurityExecutorResult>;
}

export class HttpSecurityToolExecutor implements SecurityToolExecutor {
  constructor(
    private readonly endpoint: string,
    private readonly bearerToken: string,
    private readonly fetcher: typeof fetch = fetch
  ) {}

  async execute(request: SecurityExecutorRequest): Promise<SecurityExecutorResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("security_executor_timeout")), request.timeoutMs + 5_000);
    timer.unref?.();
    try {
      const response = await this.fetcher(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.bearerToken}` },
        body: JSON.stringify(request),
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`security_executor_http_${response.status}`);
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > MAX_RESULT_BYTES) throw new Error("security_executor_result_too_large");
      const parsed = JSON.parse(text) as SecurityExecutorResult;
      if (!parsed || typeof parsed.ok !== "boolean" || typeof parsed.durationMs !== "number") throw new Error("security_executor_invalid_result");
      return parsed;
    } finally {
      clearTimeout(timer);
    }
  }
}

function normalizeHost(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

function targetHost(input: string): string {
  const value = input.trim();
  if (!value || value.length > 2048 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error("invalid_security_target");
  if (/^https?:\/\//i.test(value)) {
    const url = new URL(value);
    if (url.username || url.password) throw new Error("invalid_security_target");
    return normalizeHost(url.hostname);
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) throw new Error("invalid_security_target");
  const withoutPort = value.startsWith("[") ? value.replace(/^\[([^\]]+)\](?::\d+)?$/, "$1") : value.replace(/:\d+$/, "");
  return normalizeHost(withoutPort);
}

function ipv4Number(address: string): number | null {
  if (isIP(address) !== 4) return null;
  return address.split(".").reduce((value, octet) => ((value << 8) | Number(octet)) >>> 0, 0) >>> 0;
}

function ipv4InCidr(address: string, cidr: string): boolean {
  const [network, prefixRaw] = cidr.split("/");
  const ip = ipv4Number(address);
  const base = ipv4Number(network ?? "");
  const prefix = Number(prefixRaw);
  if (ip == null || base == null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ip & mask) === (base & mask);
}

function hostAllowed(host: string, scope: SecurityScope): boolean {
  if (isIP(host) === 4) return scope.allowIpv4Cidrs.some((cidr) => ipv4InCidr(host, cidr));
  if (isIP(host) !== 0) return false;
  return scope.allowHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

function secretMatches(value: string | undefined, expected: string | undefined): boolean {
  if (!value || !expected) return false;
  const a = Buffer.from(value);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readinessLoopbackAllowed(scope: SecurityScope): boolean {
  return scope.scopeId === "security-readiness-scope"
    && secretMatches(scope.readinessProof, process.env.DIV3RSA_SECURITY_READINESS_TOKEN?.trim());
}

function blockedInfrastructureHost(host: string, allowReadinessLoopback = false): boolean {
  const ip = ipv4Number(host);
  if (ip != null) {
    const [a, b] = host.split(".").map(Number);
    return a === 0 || (a === 127 && !allowReadinessLoopback) || (a === 169 && b === 254);
  }
  return host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "metadata.google.internal";
}

function scopeFromRun(run: ClaimedRun): SecurityScope | null {
  const resource = run.resourceContext.find((candidate) => candidate.resourceType === "security_scope");
  if (!resource) return null;
  const metadata = resource.metadata ?? {};
  const allowHosts = Array.isArray(metadata.allowHosts)
    ? metadata.allowHosts.filter((value): value is string => typeof value === "string").map(normalizeHost).filter(Boolean)
    : [];
  const allowIpv4Cidrs = Array.isArray(metadata.allowIpv4Cidrs)
    ? metadata.allowIpv4Cidrs.filter((value): value is string => typeof value === "string" && /^\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}$/.test(value))
    : [];
  const readinessProof = typeof metadata.readinessProof === "string" ? metadata.readinessProof : undefined;
  return { scopeId: resource.resourceId, allowHosts, allowIpv4Cidrs, capabilities: new Set(resource.capabilities), readinessProof };
}

function toolDefinition(scope: SecurityScope): ModelToolDefinition {
  const allowedTools = TOOL_SPECS.filter((tool) => tool.executionClass === "passive"
    ? scope.capabilities.has("security.passive") || scope.capabilities.has("security.active")
    : scope.capabilities.has("security.active"));
  return {
    name: TOOL_NAME,
    description: "Execute one bounded security check through the isolated Linux security executor. Only use against the explicitly authorized scope attached to this Lab run. Never infer or expand scope.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["tool", "target"],
      properties: {
        tool: { type: "string", enum: allowedTools.map((tool) => tool.id), description: allowedTools.map((tool) => `${tool.id}: ${tool.description}`).join(" ") },
        target: { type: "string", description: "Exact authorized hostname, IPv4 address, or HTTP(S) URL." },
        options: { type: "object", additionalProperties: true, description: "Optional bounded executor-specific settings. Arbitrary shell commands are not accepted." }
      }
    }
  };
}

export class SecurityToolRuntime implements WorkerToolRuntime {
  constructor(private readonly executor: SecurityToolExecutor | null) {}

  async list(run: ClaimedRun): Promise<ModelToolDefinition[]> {
    if (run.mode !== "lab" || !this.executor) return [];
    const scope = scopeFromRun(run);
    if (!scope || (!scope.allowHosts.length && !scope.allowIpv4Cidrs.length)) return [];
    if (!scope.capabilities.has("security.passive") && !scope.capabilities.has("security.active")) return [];
    return [toolDefinition(scope)];
  }

  async execute(run: ClaimedRun, call: ModelToolCall): Promise<unknown> {
    if (call.name !== TOOL_NAME) throw new Error("unknown_security_tool");
    if (run.mode !== "lab" || !this.executor) throw new Error("security_runtime_unavailable");
    const scope = scopeFromRun(run);
    if (!scope) throw new Error("security_scope_required");
    const toolId = typeof call.input.tool === "string" ? call.input.tool : "";
    const spec = TOOL_BY_ID.get(toolId);
    if (!spec) throw new Error("security_tool_not_allowlisted");
    if (spec.executionClass === "active" && !scope.capabilities.has("security.active")) throw new Error("security_active_capability_required");
    if (spec.executionClass === "passive" && !scope.capabilities.has("security.passive") && !scope.capabilities.has("security.active")) throw new Error("security_passive_capability_required");
    const target = typeof call.input.target === "string" ? call.input.target.trim() : "";
    const host = targetHost(target);
    const allowReadinessLoopback = readinessLoopbackAllowed(scope);
    if (blockedInfrastructureHost(host, allowReadinessLoopback)) throw new Error("security_target_blocked");
    if (!hostAllowed(host, scope)) throw new Error("security_target_out_of_scope");
    const options = call.input.options && typeof call.input.options === "object" && !Array.isArray(call.input.options)
      ? call.input.options as Record<string, unknown>
      : {};
    const result = await this.executor.execute({
      runId: run.runId,
      requestId: run.requestId,
      traceId: run.traceId,
      tool: spec.id,
      target,
      timeoutMs: spec.timeoutMs,
      executionClass: spec.executionClass,
      scope: { scopeId: scope.scopeId, allowHosts: scope.allowHosts, allowIpv4Cidrs: scope.allowIpv4Cidrs, ...(allowReadinessLoopback ? { readinessProof: scope.readinessProof } : {}) },
      options
    });
    return {
      tool: spec.id,
      executionClass: spec.executionClass,
      target,
      scopeId: scope.scopeId,
      scopeDecision: "allowed",
      ok: result.ok,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      capability: result.capability ?? null,
      auditId: result.auditId ?? null,
      findings: result.findings ?? [],
      stdout: String(result.stdout ?? "").slice(0, 120_000),
      stderr: String(result.stderr ?? "").slice(0, 40_000)
    };
  }
}
