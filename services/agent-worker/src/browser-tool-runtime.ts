import type { ModelToolCall, ModelToolDefinition } from "@div3rsa/model-sdk";
import type { ClaimedRun, WorkerToolRuntime } from "./processor";
import type { ToolExecutionContext } from "./tool-execution-context";
import { linkedAbortController, throwIfAborted } from "./tool-execution-context";

const PASSIVE = new Set(["browser_navigate", "browser_read", "browser_screenshot"]);
const ACTIVE = new Set(["browser_click", "browser_type"]);
const MAX_RESULT_BYTES = 3_000_000;

interface BrowserScope {
  scopeId: string;
  allowHosts: string[];
  allowIpv4Cidrs: string[];
  capabilities: Set<string>;
}

export interface BrowserToolRuntimeOptions {
  endpoint?: string | null;
  bearerToken?: string | null;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

const definitions: ModelToolDefinition[] = [
  {
    name: "browser_navigate",
    description: "Navigate the isolated browser to an HTTP(S) URL inside the explicit Lab security scope. All document and subresource requests are scope-checked and sent through the controlled egress proxy.",
    inputSchema: { type: "object", additionalProperties: false, required: ["url"], properties: { url: { type: "string", maxLength: 2048 } } }
  },
  {
    name: "browser_read",
    description: "Read bounded visible text and page metadata from the current scoped browser page.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} }
  },
  {
    name: "browser_screenshot",
    description: "Capture a bounded screenshot of the current scoped browser page.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} }
  },
  {
    name: "browser_click",
    description: "Click one selector in the current browser session. This active action is exposed only when the Lab scope grants security.active.",
    inputSchema: { type: "object", additionalProperties: false, required: ["selector"], properties: { selector: { type: "string", maxLength: 1000 } } }
  },
  {
    name: "browser_type",
    description: "Fill text into one selector in the current browser session. This active action is exposed only when the Lab scope grants security.active.",
    inputSchema: { type: "object", additionalProperties: false, required: ["selector", "text"], properties: { selector: { type: "string", maxLength: 1000 }, text: { type: "string", maxLength: 8000 } } }
  }
];

function normalizeHost(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

function scopeFromRun(run: ClaimedRun): BrowserScope | null {
  if (run.mode !== "lab") return null;
  const resource = run.resourceContext.find((candidate) => candidate.resourceType === "security_scope");
  if (!resource) return null;
  const metadata = resource.metadata ?? {};
  const allowHosts = Array.isArray(metadata.allowHosts)
    ? metadata.allowHosts.filter((value): value is string => typeof value === "string").map(normalizeHost).filter(Boolean)
    : [];
  const allowIpv4Cidrs = Array.isArray(metadata.allowIpv4Cidrs)
    ? metadata.allowIpv4Cidrs.filter((value): value is string => typeof value === "string")
    : [];
  return { scopeId: resource.resourceId, allowHosts, allowIpv4Cidrs, capabilities: new Set(resource.capabilities) };
}

function canUsePassive(scope: BrowserScope): boolean {
  return scope.capabilities.has("security.passive") || scope.capabilities.has("security.active");
}

function exposedDefinitions(scope: BrowserScope): ModelToolDefinition[] {
  if (!canUsePassive(scope)) return [];
  return definitions.filter((definition) => PASSIVE.has(definition.name) || scope.capabilities.has("security.active"));
}

function executorEndpoint(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("invalid_browser_executor_url"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("invalid_browser_executor_url");
  if (url.username || url.password) throw new Error("invalid_browser_executor_url");
  if (!url.pathname || url.pathname === "/") url.pathname = "/v1/execute";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function remoteError(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    return typeof parsed.error === "string" && parsed.error.trim() ? parsed.error.trim().slice(0, 180) : null;
  } catch {
    return null;
  }
}

export class BrowserToolRuntime implements WorkerToolRuntime {
  private readonly endpoint: string | null;
  private readonly token: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: BrowserToolRuntimeOptions = {}) {
    const endpoint = options.endpoint?.trim() || "";
    this.endpoint = endpoint ? executorEndpoint(endpoint) : null;
    this.token = options.bearerToken?.trim() || "";
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = Math.max(1_000, Math.min(60_000, Math.floor(options.timeoutMs ?? 30_000)));
  }

  async list(run: ClaimedRun): Promise<ModelToolDefinition[]> {
    if (!this.endpoint || !this.token) return [];
    const scope = scopeFromRun(run);
    return scope ? exposedDefinitions(scope) : [];
  }

  async execute(run: ClaimedRun, call: ModelToolCall, context?: ToolExecutionContext): Promise<unknown> {
    throwIfAborted(context?.signal);
    if (!this.endpoint || !this.token) throw new Error("browser_executor_configuration_required");
    const scope = scopeFromRun(run);
    if (!scope) throw new Error("browser_scope_required");
    if (!exposedDefinitions(scope).some((definition) => definition.name === call.name)) throw new Error(`browser_tool_not_allowed:${call.name}`);
    const executionClass = ACTIVE.has(call.name) ? "active" : PASSIVE.has(call.name) ? "passive" : null;
    if (!executionClass) throw new Error(`browser_tool_not_allowed:${call.name}`);

    const linked = linkedAbortController(context?.signal, this.timeoutMs + 5_000, "browser_executor_timeout");
    try {
      let response: Response;
      try {
        response = await this.fetcher(this.endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.token}`,
            ...(context?.operationId ? { "idempotency-key": context.operationId } : {}),
            ...(context?.executionId ? { "x-tool-execution-id": context.executionId } : {})
          },
          body: JSON.stringify({
            runId: run.runId,
            requestId: run.requestId,
            traceId: run.traceId,
            action: call.name,
            timeoutMs: this.timeoutMs,
            executionClass,
            scope: { scopeId: scope.scopeId, allowHosts: scope.allowHosts, allowIpv4Cidrs: scope.allowIpv4Cidrs },
            input: call.input
          }),
          signal: linked.controller.signal
        });
      } catch (error) {
        if (context?.signal?.aborted) throw context.signal.reason instanceof Error ? context.signal.reason : new Error("run_cancelled");
        if (linked.timedOut()) throw new Error("browser_executor_timeout");
        throw new Error("browser_executor_transport_error");
      }
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > MAX_RESULT_BYTES) throw new Error("browser_executor_result_too_large");
      if (!response.ok) throw new Error(remoteError(text) ?? `browser_executor_http_${response.status}`);
      try { return JSON.parse(text) as unknown; } catch { throw new Error("browser_executor_invalid_json"); }
    } finally {
      linked.dispose();
    }
  }
}
