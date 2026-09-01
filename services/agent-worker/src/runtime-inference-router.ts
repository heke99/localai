import type { GenerateRequest, GenerateResult, ModelAdapter, ModelCapability, ModelHealth, ModelStreamDeltaHandler } from "@div3rsa/model-sdk";
import { OpenAiCompatibleAdapter } from "../../model-gateway/src/openai-compatible-adapter";

type RpcError = { code?: string; message?: string };
export type RuntimeInferenceRpcClient = {
  rpc<T>(name: string, args: Record<string, unknown>): Promise<{ data: T | null; error: RpcError | null }>;
};

type RouteRow = Record<string, unknown>;
export type InferenceRoute = {
  providerKey: string;
  externalId: string;
  endpoint: string;
  healthUrl: string | null;
  routePriority: number;
  providerPriority: number;
};

type AdapterFactory = (endpoint: string) => ModelAdapter;
type Fetch = typeof fetch;

export type RuntimeInferenceRouterOptions = {
  staleSeconds?: number;
  reapIntervalMs?: number;
};

function numberValue(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function validEndpoint(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) return null;
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname))) return null;
    return value.replace(/\/$/, "");
  } catch {
    return null;
  }
}

function safeCode(error: unknown) {
  return error instanceof Error ? error.message.replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 160) : "runtime_inference_failed";
}

export class RuntimeInferenceRouter implements ModelAdapter {
  private readonly localCapabilities: ReadonlySet<ModelCapability>;
  private readonly staleSeconds: number;
  private readonly reapIntervalMs: number;
  private lastReapAt = 0;

  constructor(
    private readonly client: RuntimeInferenceRpcClient,
    private readonly apiKey: string,
    private readonly fetcher: Fetch = fetch,
    private readonly adapterFactory: AdapterFactory = (endpoint) => new OpenAiCompatibleAdapter(endpoint, apiKey, fetcher),
    options: RuntimeInferenceRouterOptions = {}
  ) {
    // Derive advertised capabilities from the same factory used for actual routed
    // requests. A replacement model therefore cannot silently inherit Qwen's
    // capability set merely because the control plane route is healthy.
    this.localCapabilities = this.adapterFactory("http://127.0.0.1").getCapabilities();
    this.staleSeconds = Math.min(900, Math.max(30, Math.trunc(options.staleSeconds ?? 90)));
    this.reapIntervalMs = Math.max(5_000, Math.trunc(options.reapIntervalMs ?? 30_000));
  }

  getCapabilities(): ReadonlySet<ModelCapability> { return this.localCapabilities; }
  async estimateTokens(text: string): Promise<number> { return Math.max(1, Math.ceil(text.length / 3.5)); }

  private async maybeReapStaleWorkers() {
    const now = Date.now();
    if (now - this.lastReapAt < this.reapIntervalMs) return;
    this.lastReapAt = now;
    await this.client.rpc<number>("runtime_reap_stale_workers", { target_stale_seconds: this.staleSeconds }).catch(() => undefined);
  }

  private async routes(alias: string): Promise<InferenceRoute[]> {
    await this.maybeReapStaleWorkers();
    const { data, error } = await this.client.rpc<RouteRow[]>("runtime_resolve_model_routes", { target_alias: alias });
    if (error) throw new Error(`runtime_inference_resolve_failed:${error.code ?? "unknown"}`);
    return (data ?? []).flatMap((row) => {
      if (row.worker_state !== "ready") return [];
      const endpoint = validEndpoint(row.endpoint);
      const providerKey = typeof row.provider_key === "string" ? row.provider_key : "";
      const externalId = typeof row.external_worker_id === "string" ? row.external_worker_id : "";
      if (!endpoint || !providerKey || !externalId) return [];
      return [{
        providerKey,
        externalId,
        endpoint,
        healthUrl: validEndpoint(row.health_url),
        routePriority: numberValue(row.route_priority, 100),
        providerPriority: numberValue(row.provider_priority, 100)
      }];
    }).sort((a, b) => a.routePriority - b.routePriority || a.providerPriority - b.providerPriority || a.providerKey.localeCompare(b.providerKey));
  }

  private async markFailed(route: InferenceRoute, error: unknown) {
    await this.client.rpc<boolean>("runtime_mark_worker_health", {
      target_provider_key: route.providerKey,
      target_external_worker_id: route.externalId,
      target_state: "failed",
      target_last_error_code: safeCode(error),
      target_metadata: { failedBy: "agent-worker-inference-router" }
    }).catch(() => undefined);
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const routes = await this.routes(request.alias);
    if (!routes.length) throw new Error(`runtime_inference_route_unavailable:${request.alias}`);
    const failures: string[] = [];
    for (const route of routes) {
      try {
        return await this.adapterFactory(route.endpoint).generate(request);
      } catch (error) {
        failures.push(`${route.providerKey}:${safeCode(error)}`);
        await this.markFailed(route, error);
      }
    }
    throw new Error(`runtime_inference_capacity_unavailable:${failures.join(",").slice(0, 500)}`);
  }

  async generateStreamed(request: GenerateRequest, onDelta: ModelStreamDeltaHandler): Promise<GenerateResult> {
    const routes = await this.routes(request.alias);
    if (!routes.length) throw new Error(`runtime_inference_route_unavailable:${request.alias}`);
    const failures: string[] = [];
    for (const route of routes) {
      let emitted = false;
      try {
        const adapter = this.adapterFactory(route.endpoint);
        if (!adapter.generateStreamed) {
          const result = await adapter.generate(request);
          if (result.content) {
            emitted = true;
            await onDelta(result.content);
          }
          return result;
        }
        return await adapter.generateStreamed(request, async (delta) => {
          if (delta) emitted = true;
          await onDelta(delta);
        });
      } catch (error) {
        await this.markFailed(route, error);
        if (emitted) throw error;
        failures.push(`${route.providerKey}:${safeCode(error)}`);
      }
    }
    throw new Error(`runtime_inference_capacity_unavailable:${failures.join(",").slice(0, 500)}`);
  }

  async *stream(request: GenerateRequest): AsyncIterable<string> {
    const queue: string[] = [];
    let done = false;
    let failure: unknown = null;
    let wake: (() => void) | null = null;
    void this.generateStreamed(request, async (delta) => {
      if (delta) queue.push(delta);
      wake?.();
      wake = null;
    }).then(() => { done = true; wake?.(); }).catch((error) => { failure = error; done = true; wake?.(); });
    while (!done || queue.length) {
      if (queue.length) { yield queue.shift()!; continue; }
      await new Promise<void>((resolve) => { wake = resolve; });
    }
    if (failure) throw failure;
  }

  async healthCheck(): Promise<ModelHealth> {
    const aliases = ["general-prod", "code-prod", "research-prod"];
    const startedAt = performance.now();
    for (const alias of aliases) {
      const routes = await this.routes(alias).catch(() => []);
      for (const route of routes) {
        try {
          if (route.healthUrl) {
            const response = await this.fetcher(route.healthUrl, { cache: "no-store", signal: AbortSignal.timeout(3_000) });
            if (response.ok) return { ok: true, latencyMs: performance.now() - startedAt, detail: `${route.providerKey}:${route.externalId}` };
            await this.markFailed(route, new Error(`health_http_${response.status}`));
          } else {
            const health = await this.adapterFactory(route.endpoint).healthCheck();
            if (health.ok) return health;
            await this.markFailed(route, new Error(health.detail || "health_check_failed"));
          }
        } catch (error) {
          await this.markFailed(route, error);
        }
      }
    }
    return { ok: false, latencyMs: performance.now() - startedAt, detail: "no healthy registered inference route" };
  }
}
