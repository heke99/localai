import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { ModelToolCall, ModelToolDefinition } from "@div3rsa/model-sdk";
import type { ClaimedRun, WorkerToolRuntime } from "./processor";
import {
  applyPentestCapabilityPlan,
  planPentestCapabilities,
  type PentestCapabilityPlan,
  type SecurityOperationId
} from "./pentest-capability-planner";

export type SecurityExecutionClass = "passive" | "active";

interface SecurityToolSpec {
  id: SecurityOperationId;
  executionClass: SecurityExecutionClass;
  description: string;
  timeoutMs: number;
  optionKeys: readonly string[];
}

const TOOL_NAME = "security_scan";
const TOOL_SPECS: readonly SecurityToolSpec[] = [
  { id: "http_probe", executionClass: "passive", description: "Inspect HTTP(S) reachability, response metadata and headers for an authorized target.", timeoutMs: 20_000, optionKeys: [] },
  { id: "tls_probe", executionClass: "passive", description: "Inspect TLS certificate and negotiated protocol metadata for an authorized target.", timeoutMs: 20_000, optionKeys: [] },
  { id: "dns_lookup", executionClass: "passive", description: "Resolve DNS records for an authorized hostname.", timeoutMs: 15_000, optionKeys: [] },
  { id: "port_scan", executionClass: "active", description: "Run a bounded TCP port scan against an explicitly authorized target.", timeoutMs: 60_000, optionKeys: ["ports", "maxRate"] },
  { id: "template_scan", executionClass: "active", description: "Run bounded vulnerability templates against an explicitly authorized HTTP(S) target.", timeoutMs: 90_000, optionKeys: ["rateLimit"] },
  { id: "content_discovery", executionClass: "active", description: "Run bounded web content discovery against an explicitly authorized HTTP(S) target.", timeoutMs: 60_000, optionKeys: ["rateLimit"] }
] as const;

const TOOL_BY_ID = new Map(TOOL_SPECS.map((tool) => [tool.id, tool]));
const MAX_RESULT_BYTES = 512_000;
const MODEL_STDOUT_CHARS = 12_000;
const MODEL_STDERR_CHARS = 4_000;
const MODEL_FINDINGS = 100;

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

export type SecuritySelectedSkillsResolver = (run: ClaimedRun) => Promise<readonly string[]>;

function remoteExecutorError(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    return typeof parsed?.error === "string" && parsed.error.trim() ? parsed.error.trim().slice(0, 180) : null;
  } catch {
    return null;
  }
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
      let response: Response;
      try {
        response = await this.fetcher(this.endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.bearerToken}` },
          body: JSON.stringify(request),
          signal: controller.signal
        });
      } catch (error) {
        if (controller.signal.aborted || (error instanceof Error && /abort|timeout/i.test(error.message))) throw new Error("security_executor_timeout");
        throw new Error("security_executor_transport_error");
      }
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > MAX_RESULT_BYTES) throw new Error("security_executor_result_too_large");
      if (!response.ok) {
        const remoteError = remoteExecutorError(text);
        throw new Error(remoteError ?? `security_executor_http_${response.status}`);
      }
      let parsed: SecurityExecutorResult;
      try {
        parsed = JSON.parse(text) as SecurityExecutorResult;
      } catch {
        throw new Error("security_executor_invalid_json");
      }
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
    description: "Execute one bounded security check through the isolated Linux security executor. Only use against the explicitly authorized scope attached to this Lab run. Never infer or expand scope. Options are strict: passive probes accept no options; port_scan accepts only ports/maxRate; template_scan and content_discovery accept only rateLimit.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["tool", "target"],
      properties: {
        tool: { type: "string", enum: allowedTools.map((tool) => tool.id), description: allowedTools.map((tool) => `${tool.id}: ${tool.description}`).join(" ") },
        target: { type: "string", description: "Exact authorized hostname, IPv4 address, or HTTP(S) URL." },
        options: {
          type: "object",
          additionalProperties: false,
          properties: {
            ports: { type: "array", items: { type: "integer", minimum: 1, maximum: 65535 }, maxItems: 128, description: "port_scan only: bounded TCP port list." },
            maxRate: { type: "integer", minimum: 1, maximum: 500, description: "port_scan only: maximum packets/connections per second." },
            rateLimit: { type: "integer", minimum: 1, maximum: 50, description: "template_scan/content_discovery only: bounded request rate." }
          },
          description: "Optional per-operation settings. Do not send keys that are not documented for the selected operation."
        }
      }
    }
  };
}

function validateOptions(spec: SecurityToolSpec, options: Record<string, unknown>): void {
  const allowed = new Set(spec.optionKeys);
  for (const key of Object.keys(options)) if (!allowed.has(key)) throw new Error(`invalid_security_option:${key}`);
  if (options.ports != null) {
    const raw = options.ports;
    const values = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
    if (!values.length || values.length > 128) throw new Error("invalid_security_option:ports");
    const ports = values.map((value) => Number(String(value).trim()));
    if (ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) throw new Error("invalid_security_option:ports");
  }
  for (const key of ["maxRate", "rateLimit"] as const) {
    if (options[key] == null) continue;
    const value = Number(options[key]);
    const max = key === "maxRate" ? 500 : 50;
    if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`invalid_security_option:${key}`);
  }
}

function failureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "security_executor_failed");
  return message.replace(/[^a-zA-Z0-9_:-]+/g, "_").slice(0, 160) || "security_executor_failed";
}

function hardExecutorFailure(code: string): boolean {
  return /^(?:invalid_security_target|invalid_security_option:|security_scope_required|security_target_blocked|security_target_out_of_scope|security_private_resolution_out_of_scope|security_tool_not_allowlisted|security_execution_class_mismatch|security_active_capability_required|security_passive_capability_required|security_capability_plan_violation:|unauthorized$)/.test(code);
}

function retryableExecutorFailure(code: string): boolean {
  return /timeout|transport|http_429|http_502|http_503|http_504|unavailable/i.test(code);
}

function alternativeOperations(tool: SecurityOperationId, plan: PentestCapabilityPlan | null): SecurityOperationId[] {
  const candidates: Record<SecurityOperationId, SecurityOperationId[]> = {
    dns_lookup: ["http_probe", "tls_probe"],
    http_probe: ["dns_lookup", "tls_probe"],
    tls_probe: ["dns_lookup", "http_probe"],
    port_scan: ["dns_lookup", "http_probe", "tls_probe"],
    template_scan: ["http_probe", "tls_probe"],
    content_discovery: ["http_probe", "tls_probe"]
  };
  const allowed = new Set(plan?.allowedOperations ?? []);
  return candidates[tool].filter((candidate) => candidate !== tool && (!plan || allowed.has(candidate)));
}

function resultEvidence(run: ClaimedRun, call: ModelToolCall, spec: SecurityToolSpec, target: string, scope: SecurityScope, result: SecurityExecutorResult) {
  const stdout = String(result.stdout ?? "");
  const stderr = String(result.stderr ?? "");
  const findings = Array.isArray(result.findings) ? result.findings : [];
  const stdoutPreview = stdout.slice(0, MODEL_STDOUT_CHARS);
  const stderrPreview = stderr.slice(0, MODEL_STDERR_CHARS);
  return {
    schemaVersion: 1,
    kind: "security_tool_observation",
    observationId: `${run.traceId}:${call.id}`,
    tool: spec.id,
    executionClass: spec.executionClass,
    target,
    scopeId: scope.scopeId,
    status: result.ok ? "completed" : "failed",
    ok: result.ok,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    capability: result.capability ?? null,
    auditId: result.auditId ?? null,
    findings: findings.slice(0, MODEL_FINDINGS),
    findingCount: findings.length,
    raw: {
      stdoutPreview,
      stderrPreview,
      stdoutBytes: Buffer.byteLength(stdout, "utf8"),
      stderrBytes: Buffer.byteLength(stderr, "utf8"),
      truncated: stdout.length > stdoutPreview.length || stderr.length > stderrPreview.length
    }
  };
}

export class SecurityToolRuntime implements WorkerToolRuntime {
  constructor(
    private readonly executor: SecurityToolExecutor | null,
    private readonly selectedSkills: SecuritySelectedSkillsResolver = async () => []
  ) {}

  private async definitionAndPlan(run: ClaimedRun, scope: SecurityScope): Promise<{ definition: ModelToolDefinition; plan: PentestCapabilityPlan | null }> {
    const definition = toolDefinition(scope);
    let skillNames: readonly string[] = [];
    try {
      skillNames = await this.selectedSkills(run);
    } catch {
      skillNames = [];
    }
    const plan = planPentestCapabilities({ mode: run.mode, prompt: run.prompt, selectedSkills: skillNames, toolDefinitions: [definition] });
    return { definition: plan ? applyPentestCapabilityPlan(definition, plan) : definition, plan };
  }

  async list(run: ClaimedRun): Promise<ModelToolDefinition[]> {
    if (run.mode !== "lab" || !this.executor) return [];
    const scope = scopeFromRun(run);
    if (!scope || (!scope.allowHosts.length && !scope.allowIpv4Cidrs.length)) return [];
    if (!scope.capabilities.has("security.passive") && !scope.capabilities.has("security.active")) return [];
    const { definition } = await this.definitionAndPlan(run, scope);
    return [definition];
  }

  async execute(run: ClaimedRun, call: ModelToolCall): Promise<unknown> {
    if (call.name !== TOOL_NAME) throw new Error("unknown_security_tool");
    if (run.mode !== "lab" || !this.executor) throw new Error("security_runtime_unavailable");
    const scope = scopeFromRun(run);
    if (!scope) throw new Error("security_scope_required");
    const toolId = typeof call.input.tool === "string" ? call.input.tool : "";
    const spec = TOOL_BY_ID.get(toolId as SecurityOperationId);
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
    validateOptions(spec, options);

    const baseDefinition = toolDefinition(scope);
    const plan = planPentestCapabilities({ mode: run.mode, prompt: run.prompt, toolDefinitions: [baseDefinition] });
    if (plan && !plan.allowedOperations.includes(spec.id)) throw new Error(`security_capability_plan_violation:${spec.id}`);

    let result: SecurityExecutorResult;
    try {
      result = await this.executor.execute({
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
    } catch (error) {
      const errorCode = failureCode(error);
      if (hardExecutorFailure(errorCode)) throw error instanceof Error ? error : new Error(errorCode);
      return {
        schemaVersion: 1,
        tool: spec.id,
        executionClass: spec.executionClass,
        target,
        scopeId: scope.scopeId,
        scopeDecision: "allowed",
        ok: false,
        status: "executor_error",
        exitCode: null,
        durationMs: null,
        capability: null,
        auditId: null,
        findings: [],
        errorCode,
        retryable: retryableExecutorFailure(errorCode),
        suggestedNextOperations: alternativeOperations(spec.id, plan),
        evidence: {
          schemaVersion: 1,
          kind: "security_tool_observation",
          observationId: `${run.traceId}:${call.id}`,
          tool: spec.id,
          target,
          scopeId: scope.scopeId,
          status: "executor_error",
          errorCode
        },
        stdout: "",
        stderr: ""
      };
    }

    const evidence = resultEvidence(run, call, spec, target, scope, result);
    return {
      schemaVersion: 1,
      tool: spec.id,
      executionClass: spec.executionClass,
      target,
      scopeId: scope.scopeId,
      scopeDecision: "allowed",
      ok: result.ok,
      status: result.ok ? "completed" : "failed",
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      capability: result.capability ?? null,
      auditId: result.auditId ?? null,
      findings: evidence.findings,
      findingCount: evidence.findingCount,
      evidence,
      stdout: evidence.raw.stdoutPreview,
      stderr: evidence.raw.stderrPreview,
      rawOutputTruncated: evidence.raw.truncated
    };
  }
}
