import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { appendFile, mkdir } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname } from "node:path";
import { spawn } from "node:child_process";

export type SecurityExecutionClass = "passive" | "active";

export interface SecurityExecutorRequest {
  runId: string;
  requestId: string;
  traceId: string;
  tool: string;
  target: string;
  timeoutMs: number;
  executionClass: SecurityExecutionClass;
  scope: { scopeId: string; allowHosts: string[]; allowIpv4Cidrs: string[] };
  options: Record<string, unknown>;
}

export interface SecurityFinding {
  kind: string;
  severity?: string;
  title: string;
  evidence?: Record<string, unknown>;
}

export interface SecurityExecutorResult {
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  findings: SecurityFinding[];
  auditId: string;
  capability: string;
}

interface ToolCommand {
  command: string;
  args: string[];
  capability: string;
}

export interface SecurityExecutorOptions {
  auditLogPath?: string;
  maxOutputBytes?: number;
  resolveHost?: (hostname: string) => Promise<string[]>;
  wordlistPath?: string | null;
  spawnProcess?: typeof spawn;
}

const MAX_TIMEOUT_MS = 90_000;
const MAX_OUTPUT_BYTES = 512_000;
const MAX_PORTS = 128;
const ACTIVE_TOOLS = new Set(["port_scan", "template_scan", "content_discovery"]);
const PASSIVE_TOOLS = new Set(["http_probe", "tls_probe", "dns_lookup"]);
const ALL_TOOLS = new Set([...PASSIVE_TOOLS, ...ACTIVE_TOOLS]);
const SAFE_ENV_KEYS = ["PATH", "LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR"] as const;

function normalizeHost(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
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

function hostAllowed(host: string, request: SecurityExecutorRequest): boolean {
  if (isIP(host) === 4) return request.scope.allowIpv4Cidrs.some((cidr) => ipv4InCidr(host, cidr));
  if (isIP(host) !== 0) return false;
  return request.scope.allowHosts.map(normalizeHost).some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

function infrastructureBlocked(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return a === 0 || a === 127 || (a === 169 && b === 254) || a >= 224;
  }
  if (isIP(address) === 6) {
    const value = address.toLowerCase();
    return value === "::" || value === "::1" || /^fe[89ab]/.test(value);
  }
  const host = normalizeHost(address);
  return host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "metadata.google.internal";
}

function targetParts(input: string): { host: string; url: URL | null } {
  const value = input.trim();
  if (!value || value.length > 2048 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error("invalid_security_target");
  if (/^https?:\/\//i.test(value)) {
    const url = new URL(value);
    if (url.username || url.password) throw new Error("invalid_security_target");
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("invalid_security_target");
    return { host: normalizeHost(url.hostname), url };
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) throw new Error("invalid_security_target");
  const host = value.startsWith("[") ? value.replace(/^\[([^\]]+)\](?::\d+)?$/, "$1") : value.replace(/:\d+$/, "");
  return { host: normalizeHost(host), url: null };
}

async function defaultResolveHost(hostname: string): Promise<string[]> {
  if (isIP(hostname)) return [hostname];
  return (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);
}

async function enforceScope(request: SecurityExecutorRequest, resolveHost: (hostname: string) => Promise<string[]>): Promise<{ host: string; url: URL | null }> {
  if (!request.scope?.scopeId) throw new Error("security_scope_required");
  if (!ALL_TOOLS.has(request.tool)) throw new Error("security_tool_not_allowlisted");
  const expectedClass: SecurityExecutionClass = ACTIVE_TOOLS.has(request.tool) ? "active" : "passive";
  if (request.executionClass !== expectedClass) throw new Error("security_execution_class_mismatch");
  const parsed = targetParts(request.target);
  if (infrastructureBlocked(parsed.host)) throw new Error("security_target_blocked");
  if (!hostAllowed(parsed.host, request)) throw new Error("security_target_out_of_scope");

  let addresses: string[];
  try {
    addresses = await resolveHost(parsed.host);
  } catch {
    throw new Error("security_target_dns_failed");
  }
  if (!addresses.length) throw new Error("security_target_dns_failed");
  for (const address of addresses) {
    if (infrastructureBlocked(address)) throw new Error("security_target_blocked");
    if (isIP(address) === 4 && /^10\.|^192\.168\.|^172\.(?:1[6-9]|2\d|3[01])\./.test(address)) {
      if (!request.scope.allowIpv4Cidrs.some((cidr) => ipv4InCidr(address, cidr))) throw new Error("security_private_resolution_out_of_scope");
    }
  }
  return parsed;
}

function boundedTimeout(value: number): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error("invalid_security_timeout");
  return Math.min(Math.floor(value), MAX_TIMEOUT_MS);
}

function numberOption(options: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  if (options[key] == null) return fallback;
  const value = Number(options[key]);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`invalid_security_option:${key}`);
  return value;
}

function portsOption(options: Record<string, unknown>): string {
  const raw = options.ports;
  if (raw == null) return "80,443,8080,8443";
  const values = Array.isArray(raw) ? raw : String(raw).split(",");
  if (!values.length || values.length > MAX_PORTS) throw new Error("invalid_security_option:ports");
  const ports = values.map((value) => Number(String(value).trim()));
  if (ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) throw new Error("invalid_security_option:ports");
  return [...new Set(ports)].join(",");
}

function targetUrl(parsed: { host: string; url: URL | null }): string {
  return parsed.url?.toString() ?? `https://${parsed.host}/`;
}

function commandFor(request: SecurityExecutorRequest, parsed: { host: string; url: URL | null }, wordlistPath: string | null): ToolCommand {
  const timeoutSeconds = Math.max(1, Math.ceil(boundedTimeout(request.timeoutMs) / 1000));
  switch (request.tool) {
    case "http_probe":
      return {
        command: "curl",
        args: ["--silent", "--show-error", "--dump-header", "-", "--output", "/dev/null", "--max-redirs", "0", "--max-time", String(timeoutSeconds), "--proto", "=http,https", targetUrl(parsed)],
        capability: "curl:http_probe"
      };
    case "tls_probe": {
      const port = parsed.url?.port || (parsed.url?.protocol === "http:" ? "80" : "443");
      return {
        command: "openssl",
        args: ["s_client", "-connect", `${parsed.host}:${port}`, "-servername", parsed.host, "-brief", "-no_ign_eof"],
        capability: "openssl:tls_probe"
      };
    }
    case "dns_lookup":
      return {
        command: "dig",
        args: ["+time=3", "+tries=1", "+noall", "+answer", parsed.host, "A"],
        capability: "dig:dns_lookup"
      };
    case "port_scan":
      return {
        command: "nmap",
        args: ["-n", "-Pn", "-sT", "--max-retries", "1", "--max-rate", String(numberOption(request.options, "maxRate", 100, 1, 500)), "--host-timeout", `${timeoutSeconds}s`, "-p", portsOption(request.options), parsed.host],
        capability: "nmap:bounded_connect_scan"
      };
    case "template_scan":
      return {
        command: "nuclei",
        args: ["-u", targetUrl(parsed), "-jsonl", "-silent", "-no-interactsh", "-disable-update-check", "-rate-limit", String(numberOption(request.options, "rateLimit", 20, 1, 50)), "-bulk-size", "5", "-concurrency", "5", "-timeout", "5", "-retries", "0", "-exclude-tags", "dos,fuzz,intrusive"],
        capability: "nuclei:bounded_templates"
      };
    case "content_discovery":
      if (!wordlistPath) throw new Error("security_content_wordlist_required");
      return {
        command: "ffuf",
        args: ["-s", "-w", wordlistPath, "-u", `${targetUrl(parsed).replace(/\/$/, "")}/FUZZ`, "-rate", String(numberOption(request.options, "rateLimit", 20, 1, 50)), "-t", "5", "-maxtime", String(timeoutSeconds), "-mc", "all", "-fc", "404", "-of", "json", "-o", "/dev/stdout"],
        capability: "ffuf:bounded_content_discovery"
      };
    default:
      throw new Error("security_tool_not_allowlisted");
  }
}

function safeEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV ?? "production" };
  for (const key of SAFE_ENV_KEYS) if (process.env[key]) env[key] = process.env[key];
  env.HOME = "/nonexistent";
  env.NO_COLOR = "1";
  return env;
}

async function executeProcess(command: ToolCommand, timeoutMs: number, maxBytes: number, spawnProcess: typeof spawn): Promise<{ exitCode: number | null; durationMs: number; stdout: string; stderr: string }> {
  const started = performance.now();
  return await new Promise((resolve, reject) => {
    const child = spawnProcess(command.command, command.args, {
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: safeEnvironment()
    });
    let stdout = "";
    let stderr = "";
    let totalBytes = 0;
    let overflow = false;
    const collect = (chunk: Buffer, stream: "stdout" | "stderr") => {
      if (overflow) return;
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        overflow = true;
        return;
      }
      if (stream === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };
    child.stdout?.on("data", (chunk: Buffer) => collect(chunk, "stdout"));
    child.stderr?.on("data", (chunk: Buffer) => collect(chunk, "stderr"));
    const timer = setTimeout(() => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch { /* already exited */ }
    }, timeoutMs);
    timer.unref?.();
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (overflow) return reject(new Error("security_executor_output_limit"));
      resolve({ exitCode: code, durationMs: Math.round(performance.now() - started), stdout, stderr });
    });
  });
}

function parseFindings(tool: string, stdout: string): SecurityFinding[] {
  if (tool === "template_scan") {
    const findings: SecurityFinding[] = [];
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as Record<string, unknown>;
        const info = row.info && typeof row.info === "object" ? row.info as Record<string, unknown> : {};
        findings.push({
          kind: "template_match",
          severity: typeof info.severity === "string" ? info.severity : undefined,
          title: typeof info.name === "string" ? info.name : typeof row["template-id"] === "string" ? String(row["template-id"]) : "Template match",
          evidence: { templateId: row["template-id"] ?? null, matchedAt: row["matched-at"] ?? row.host ?? null }
        });
      } catch { /* retain raw stdout without manufacturing findings */ }
    }
    return findings.slice(0, 500);
  }
  if (tool === "port_scan") {
    return stdout.split(/\r?\n/).filter((line) => /^\d+\/tcp\s+open\b/.test(line)).slice(0, MAX_PORTS).map((line) => ({ kind: "open_port", title: line.trim() }));
  }
  if (tool === "content_discovery") {
    try {
      const parsed = JSON.parse(stdout) as { results?: Array<Record<string, unknown>> };
      return (parsed.results ?? []).slice(0, 500).map((row) => ({ kind: "content_match", title: String(row.url ?? row.input ?? "Content match"), evidence: { status: row.status ?? null, length: row.length ?? null } }));
    } catch { return []; }
  }
  return [];
}

async function writeAudit(path: string | undefined, entry: Record<string, unknown>): Promise<void> {
  if (!path) return;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await appendFile(path, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
}

export class LinuxSecurityExecutor {
  private readonly resolveHost: (hostname: string) => Promise<string[]>;
  private readonly maxOutputBytes: number;
  private readonly spawnProcess: typeof spawn;

  constructor(private readonly options: SecurityExecutorOptions = {}) {
    this.resolveHost = options.resolveHost ?? defaultResolveHost;
    this.maxOutputBytes = Math.max(1_024, Math.min(options.maxOutputBytes ?? MAX_OUTPUT_BYTES, MAX_OUTPUT_BYTES));
    this.spawnProcess = options.spawnProcess ?? spawn;
  }

  async execute(request: SecurityExecutorRequest): Promise<SecurityExecutorResult> {
    const auditId = randomUUID();
    const startedAt = new Date().toISOString();
    const parsed = await enforceScope(request, this.resolveHost);
    const timeoutMs = boundedTimeout(request.timeoutMs);
    const command = commandFor(request, parsed, this.options.wordlistPath ?? null);
    const requestHash = createHash("sha256").update(JSON.stringify({ tool: request.tool, target: request.target, scope: request.scope, options: request.options, executionClass: request.executionClass })).digest("hex");
    let processResult: Awaited<ReturnType<typeof executeProcess>>;
    try {
      processResult = await executeProcess(command, timeoutMs, this.maxOutputBytes, this.spawnProcess);
    } catch (error) {
      await writeAudit(this.options.auditLogPath, { auditId, startedAt, finishedAt: new Date().toISOString(), runId: request.runId, requestId: request.requestId, traceId: request.traceId, scopeId: request.scope.scopeId, tool: request.tool, executionClass: request.executionClass, target: request.target, requestHash, capability: command.capability, status: "error", error: error instanceof Error ? error.message : "security_executor_failed" });
      throw error;
    }
    const findings = parseFindings(request.tool, processResult.stdout);
    const result: SecurityExecutorResult = {
      ok: processResult.exitCode === 0,
      exitCode: processResult.exitCode,
      durationMs: processResult.durationMs,
      stdout: processResult.stdout,
      stderr: processResult.stderr,
      findings,
      auditId,
      capability: command.capability
    };
    await writeAudit(this.options.auditLogPath, { auditId, startedAt, finishedAt: new Date().toISOString(), runId: request.runId, requestId: request.requestId, traceId: request.traceId, scopeId: request.scope.scopeId, tool: request.tool, executionClass: request.executionClass, target: request.target, requestHash, capability: command.capability, status: result.ok ? "completed" : "failed", exitCode: result.exitCode, durationMs: result.durationMs, findings: findings.length, outputHash: createHash("sha256").update(result.stdout).update("\0").update(result.stderr).digest("hex") });
    return result;
  }
}

export function bearerMatches(header: string | undefined, expected: string): boolean {
  if (!expected) return false;
  const value = header?.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
  const a = Buffer.from(value);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
