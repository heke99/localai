import { lookup } from "node:dns/promises";
import { request as requestHttp, type IncomingHttpHeaders } from "node:http";
import { request as requestHttps } from "node:https";
import { isIP } from "node:net";
import type { ModelToolCall, ModelToolDefinition } from "@div3rsa/model-sdk";
import type { ClaimedRun, WorkerToolRuntime } from "./processor";
import type { ToolExecutionContext } from "./tool-execution-context";
import { linkedAbortController, throwIfAborted } from "./tool-execution-context";

const TOOL_NAME = "http_request";
const METHODS = ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"] as const;
type HttpMethod = typeof METHODS[number];
const MAX_BODY_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_REDIRECTS = 4;
const BLOCKED_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

interface HttpScope {
  scopeId: string;
  allowHosts: string[];
  capabilities: Set<string>;
}

export interface ScopedHttpToolRuntimeOptions {
  egressProxyUrl?: string | null;
  timeoutMs?: number;
  maxResponseBytes?: number;
  resolveHost?: (hostname: string) => Promise<string[]>;
}

function normalizeHost(value: string): string {
  return value.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function scopeFromRun(run: ClaimedRun): HttpScope | null {
  if (run.mode !== "lab") return null;
  const resource = run.resourceContext.find((candidate) => candidate.resourceType === "security_scope");
  if (!resource) return null;
  const metadata = resource.metadata ?? {};
  const allowHosts = Array.isArray(metadata.allowHosts)
    ? metadata.allowHosts.filter((value): value is string => typeof value === "string").map(normalizeHost).filter(Boolean)
    : [];
  return { scopeId: resource.resourceId, allowHosts, capabilities: new Set(resource.capabilities) };
}

function toolDefinition(): ModelToolDefinition {
  return {
    name: TOOL_NAME,
    description: "Send one bounded HTTP request to an explicitly authorized Lab target through the controlled DNS-pinned egress proxy. This tool is active-only; use security_scan/http_probe or browser_read for passive inspection. Redirects are re-scoped and mutating requests are never auto-followed.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["method", "url"],
      properties: {
        method: { type: "string", enum: [...METHODS] },
        url: { type: "string", maxLength: 2048 },
        headers: { type: "object", additionalProperties: true },
        body: { type: "string", maxLength: MAX_BODY_BYTES }
      }
    }
  };
}

function proxyEndpoint(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("invalid_egress_proxy_url"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("invalid_egress_proxy_url");
  if (url.username || url.password || (url.pathname !== "/" && url.pathname !== "")) throw new Error("invalid_egress_proxy_url");
  return url;
}

function ipv4Parts(address: string): number[] | null {
  if (isIP(address) !== 4) return null;
  const parts = address.split(".").map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) ? parts : null;
}

function blockedAddress(address: string): boolean {
  const v4 = ipv4Parts(address);
  if (v4) {
    const [a, b] = v4;
    return a === 0
      || a === 10
      || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 0 || b === 168))
      || (a === 198 && (b === 18 || b === 19))
      || a >= 224;
  }
  if (isIP(address) === 6) {
    const value = normalizeHost(address);
    if (value === "::" || value === "::1" || /^f[cd]/i.test(value) || /^fe[89ab]/i.test(value) || /^ff/i.test(value)) return true;
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value)?.[1];
    return mapped ? blockedAddress(mapped) : false;
  }
  return true;
}

async function defaultResolveHost(hostname: string): Promise<string[]> {
  if (isIP(hostname)) return [hostname];
  return (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);
}

function hostAllowed(host: string, scope: HttpScope): boolean {
  if (isIP(host) !== 0) return false;
  return scope.allowHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

async function assertTargetAllowed(raw: string, scope: HttpScope, resolveHost: (hostname: string) => Promise<string[]>): Promise<URL> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("http_invalid_url"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("http_protocol_not_allowed");
  if (url.username || url.password) throw new Error("http_url_userinfo_blocked");
  const host = normalizeHost(url.hostname);
  if (!scope.scopeId || !hostAllowed(host, scope)) throw new Error("http_target_out_of_scope");
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (port !== 80 && port !== 443) throw new Error("http_port_not_allowed");
  let addresses: string[];
  try { addresses = await resolveHost(host); } catch { throw new Error("http_target_dns_failed"); }
  if (!addresses.length) throw new Error("http_target_dns_failed");
  if (addresses.some(blockedAddress)) throw new Error("http_target_blocked");
  return url;
}

function methodInput(value: unknown): HttpMethod {
  if (typeof value !== "string") throw new Error("http_method_required");
  const method = value.trim().toUpperCase() as HttpMethod;
  if (!METHODS.includes(method)) throw new Error("http_method_not_allowed");
  return method;
}

function headersInput(value: unknown): Record<string, string> {
  if (value == null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("http_headers_invalid");
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 64) throw new Error("http_headers_too_large");
  const headers: Record<string, string> = {};
  for (const [rawName, rawValue] of entries) {
    const name = rawName.trim().toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name)) throw new Error("http_header_name_invalid");
    if (BLOCKED_HEADERS.has(name)) throw new Error(`http_header_not_allowed:${name}`);
    if (typeof rawValue !== "string" || rawValue.length > 8192 || /[\r\n]/.test(rawValue)) throw new Error(`http_header_value_invalid:${name}`);
    headers[name] = rawValue;
  }
  return headers;
}

function bodyInput(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string") throw new Error("http_body_invalid");
  if (Buffer.byteLength(value, "utf8") > MAX_BODY_BYTES) throw new Error("http_body_too_large");
  return value;
}

function readableContentType(value: string | undefined): boolean {
  const type = (value ?? "").split(";", 1)[0].trim().toLowerCase();
  return type.startsWith("text/") || type.includes("json") || type.includes("xml") || type.includes("javascript") || type === "application/x-www-form-urlencoded";
}

async function proxyRequest(
  proxy: URL,
  target: URL,
  method: HttpMethod,
  headers: Record<string, string>,
  body: string | undefined,
  maxResponseBytes: number,
  signal: AbortSignal
): Promise<{ status: number; headers: IncomingHttpHeaders; bytes: Buffer; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const transport = proxy.protocol === "https:" ? requestHttps : requestHttp;
    const requestHeaders: Record<string, string> = { ...headers };
    if (body !== undefined) requestHeaders["content-length"] = String(Buffer.byteLength(body, "utf8"));
    const request = transport({
      hostname: proxy.hostname,
      port: Number(proxy.port || (proxy.protocol === "https:" ? 443 : 80)),
      method,
      path: target.toString(),
      headers: requestHeaders,
      signal
    }, (response) => {
      const chunks: Buffer[] = [];
      let total = 0;
      let truncated = false;
      response.on("data", (chunkValue: Buffer | string) => {
        if (truncated) return;
        const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
        const remaining = maxResponseBytes - total;
        if (chunk.length > remaining) {
          if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
          total += Math.max(remaining, 0);
          truncated = true;
          response.destroy();
          return;
        }
        chunks.push(chunk);
        total += chunk.length;
      });
      response.on("end", () => resolve({ status: response.statusCode ?? 502, headers: response.headers, bytes: Buffer.concat(chunks), truncated }));
      response.on("close", () => {
        if (truncated) resolve({ status: response.statusCode ?? 502, headers: response.headers, bytes: Buffer.concat(chunks), truncated: true });
      });
      response.on("error", reject);
    });
    request.on("error", reject);
    if (body !== undefined) request.end(body);
    else request.end();
  });
}

export class ScopedHttpToolRuntime implements WorkerToolRuntime {
  private readonly proxy: URL | null;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly resolveHost: (hostname: string) => Promise<string[]>;

  constructor(options: ScopedHttpToolRuntimeOptions = {}) {
    const rawProxy = options.egressProxyUrl?.trim() || "";
    this.proxy = rawProxy ? proxyEndpoint(rawProxy) : null;
    this.timeoutMs = Math.max(1_000, Math.min(60_000, Math.floor(options.timeoutMs ?? 30_000)));
    this.maxResponseBytes = Math.max(16_384, Math.min(2_000_000, Math.floor(options.maxResponseBytes ?? MAX_RESPONSE_BYTES)));
    this.resolveHost = options.resolveHost ?? defaultResolveHost;
  }

  async list(run: ClaimedRun): Promise<ModelToolDefinition[]> {
    if (!this.proxy) return [];
    const scope = scopeFromRun(run);
    return scope?.capabilities.has("security.active") ? [toolDefinition()] : [];
  }

  async execute(run: ClaimedRun, call: ModelToolCall, context?: ToolExecutionContext): Promise<unknown> {
    throwIfAborted(context?.signal);
    if (!this.proxy) throw new Error("http_egress_proxy_required");
    if (call.name !== TOOL_NAME) throw new Error(`http_tool_not_supported:${call.name}`);
    const scope = scopeFromRun(run);
    if (!scope?.capabilities.has("security.active")) throw new Error("http_active_scope_required");

    let method = methodInput(call.input.method);
    let body = bodyInput(call.input.body);
    const headers = headersInput(call.input.headers);
    let current = await assertTargetAllowed(String(call.input.url ?? ""), scope, this.resolveHost);
    const linked = linkedAbortController(context?.signal, this.timeoutMs, "http_request_timeout");
    try {
      for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
        const response = await proxyRequest(this.proxy, current, method, headers, body, this.maxResponseBytes, linked.controller.signal);
        const location = typeof response.headers.location === "string" ? response.headers.location : undefined;
        const redirectStatus = [301, 302, 303, 307, 308].includes(response.status);
        if (redirectStatus && location && (method === "GET" || method === "HEAD")) {
          if (redirect >= MAX_REDIRECTS) throw new Error("http_redirect_limit");
          current = await assertTargetAllowed(new URL(location, current).toString(), scope, this.resolveHost);
          if (response.status === 303) { method = "GET"; body = undefined; }
          continue;
        }
        const contentType = Array.isArray(response.headers["content-type"]) ? response.headers["content-type"]?.[0] : response.headers["content-type"];
        const responseBody = readableContentType(contentType)
          ? { body: response.bytes.toString("utf8"), bodyEncoding: "utf8" }
          : { body: response.bytes.toString("base64"), bodyEncoding: "base64" };
        return {
          ok: response.status >= 200 && response.status < 400,
          method,
          url: current.toString(),
          status: response.status,
          headers: Object.fromEntries(Object.entries(response.headers).filter(([key]) => !["set-cookie", "proxy-authenticate"].includes(key.toLowerCase()))),
          ...responseBody,
          truncated: response.truncated
        };
      }
      throw new Error("http_redirect_limit");
    } catch (error) {
      if (context?.signal?.aborted) throw context.signal.reason instanceof Error ? context.signal.reason : new Error("run_cancelled");
      if (linked.timedOut()) throw new Error("http_request_timeout");
      throw error;
    } finally {
      linked.dispose();
    }
  }
}
