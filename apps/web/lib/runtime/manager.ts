import {
  DEFAULT_RUNTIME_PROFILE,
  type EnabledRuntimeProvider,
  type RegisteredRuntimeRoute,
  type RuntimeAlias,
  type RuntimeInstance,
  type RuntimeManagerResult,
  type RuntimeProviderAdapter,
  type RuntimeRegistry
} from "./contracts";

type RuntimeManagerOptions = {
  profile?: string;
  providerOrder?: string[];
  cacheMs?: number;
  leaseTtlSeconds?: number;
  logger?: Pick<Console, "info" | "warn" | "error">;
};

type CacheEntry = { expiresAt: number; result: RuntimeManagerResult };

function routeAsInstance(route: RegisteredRuntimeRoute): RuntimeInstance {
  return {
    providerKey: route.providerKey,
    providerKind: route.providerKind,
    providerPriority: route.providerPriority,
    externalId: route.externalId,
    profile: route.profile,
    state: route.state,
    endpoint: route.endpoint,
    healthUrl: route.healthUrl,
    region: route.region,
    gpuType: route.gpuType,
    gpuCount: route.gpuCount,
    vramTotalBytes: route.vramTotalBytes,
    routePriority: route.routePriority,
    metadata: route.metadata
  };
}

function safeErrorCode(error: unknown) {
  if (error instanceof Error) {
    return error.message.replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 160) || "runtime_provider_failed";
  }
  return "runtime_provider_failed";
}

function providerRank(provider: RuntimeProviderAdapter, catalog: Map<string, EnabledRuntimeProvider>, explicitOrder: Map<string, number>) {
  const order = explicitOrder.get(provider.key);
  const priority = catalog.get(provider.key)?.priority ?? provider.defaultPriority;
  return { order: order ?? Number.MAX_SAFE_INTEGER, priority };
}

function isProviderNeutralWorker(route: RegisteredRuntimeRoute) {
  return route.metadata.runtimeContract === "div3rsa-runtime-v1";
}

async function probeSelfRegisteredRoute(route: RegisteredRuntimeRoute) {
  if (!route.healthUrl) return false;
  let parsed: URL;
  try { parsed = new URL(route.healthUrl); } catch { return false; }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) return false;
  const timeout = Number(process.env.DIV3RSA_RUNTIME_REGISTERED_HEALTH_TIMEOUT_MS ?? "3000");
  try {
    const response = await fetch(parsed, {
      method: "GET",
      cache: "no-store",
      signal: AbortSignal.timeout(Number.isFinite(timeout) && timeout > 0 ? timeout : 3000)
    });
    return response.ok;
  } catch {
    return false;
  }
}

export class RuntimeManager {
  private readonly adapters = new Map<string, RuntimeProviderAdapter>();
  private readonly cache = new Map<RuntimeAlias, CacheEntry>();
  private readonly inFlight = new Map<RuntimeAlias, Promise<RuntimeManagerResult>>();
  private readonly profile: string;
  private readonly providerOrder: string[];
  private readonly cacheMs: number;
  private readonly leaseTtlSeconds: number;
  private readonly logger: Pick<Console, "info" | "warn" | "error">;

  constructor(private readonly registry: RuntimeRegistry, adapters: RuntimeProviderAdapter[], options: RuntimeManagerOptions = {}) {
    for (const adapter of adapters) {
      if (this.adapters.has(adapter.key)) throw new Error(`duplicate_runtime_provider:${adapter.key}`);
      this.adapters.set(adapter.key, adapter);
    }
    this.profile = options.profile ?? DEFAULT_RUNTIME_PROFILE;
    this.providerOrder = options.providerOrder ?? [];
    this.cacheMs = Math.max(0, options.cacheMs ?? 15_000);
    this.leaseTtlSeconds = Math.min(900, Math.max(15, options.leaseTtlSeconds ?? 120));
    this.logger = options.logger ?? console;
  }

  ensure(alias: RuntimeAlias): Promise<RuntimeManagerResult> {
    const cached = this.cache.get(alias);
    if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.result);

    const existing = this.inFlight.get(alias);
    if (existing) return existing;

    const work = this.ensureUncached(alias).finally(() => {
      this.inFlight.delete(alias);
    });
    this.inFlight.set(alias, work);
    return work;
  }

  private async ensureUncached(alias: RuntimeAlias): Promise<RuntimeManagerResult> {
    const registered = await this.registry.resolve(alias);

    // Only a route marked ready by the actual agent worker can be reused. A
    // provider/model health check alone is not sufficient to prove queue work
    // can be processed end-to-end. Provider-neutral workers may self-register
    // even when the control plane has no lifecycle adapter for their GPU vendor.
    for (const route of registered.filter((candidate) => candidate.state === "ready")) {
      const adapter = this.adapters.get(route.providerKey);
      try {
        const healthy = adapter?.configured()
          ? await adapter.health(route)
          : isProviderNeutralWorker(route) && await probeSelfRegisteredRoute(route);
        if (!healthy) continue;
        await this.registry.markHealth(route.providerKey, route.externalId, "ready", null, { verifiedBy: "runtime-manager" });
        const result: RuntimeManagerResult = { configured: true, alias, instance: routeAsInstance(route), reused: true };
        this.remember(alias, result);
        return result;
      } catch (error) {
        this.logger.warn("[runtime-manager] registered route health failed", { alias, provider: route.providerKey, code: safeErrorCode(error) });
      }
    }

    const catalog = new Map((await this.registry.enabledProviders()).map((provider) => [provider.key, provider]));
    const explicitOrder = new Map(this.providerOrder.map((key, index) => [key, index]));
    const enforceCatalog = catalog.size > 0;
    const providers = [...this.adapters.values()]
      .filter((adapter) => adapter.configured() && (!enforceCatalog || catalog.has(adapter.key)))
      .sort((left, right) => {
        const a = providerRank(left, catalog, explicitOrder);
        const b = providerRank(right, catalog, explicitOrder);
        return a.order - b.order || a.priority - b.priority || left.key.localeCompare(right.key);
      });

    if (!providers.length) throw new Error("runtime_provider_unconfigured");

    const failures: string[] = [];
    for (const adapter of providers) {
      const preferred = registered.find((route) => route.providerKey === adapter.key) ?? null;
      const holderId = `runtime-manager-${crypto.randomUUID()}`;
      let leaseAcquired = false;
      try {
        if (adapter.kind === "managed") {
          leaseAcquired = await this.registry.acquireProvisioningLease(alias, adapter.key, holderId, this.leaseTtlSeconds);
          if (!leaseAcquired) throw new Error("runtime_provisioning_in_progress");
        }

        const instance = await adapter.ensure({ alias, profile: this.profile, preferred });
        const provider = catalog.get(adapter.key);
        const normalized: RuntimeInstance = {
          ...instance,
          providerKey: adapter.key,
          providerKind: adapter.kind,
          providerPriority: provider?.priority ?? instance.providerPriority ?? adapter.defaultPriority,
          profile: instance.profile || this.profile,
          routePriority: instance.routePriority ?? 100
        };
        await this.registry.register(alias, normalized);
        const result: RuntimeManagerResult = { configured: true, alias, instance: normalized, reused: false };
        if (normalized.state === "ready") this.remember(alias, result);
        this.logger.info("[runtime-manager] runtime selected", { alias, provider: normalized.providerKey, state: normalized.state, reused: false });
        return result;
      } catch (error) {
        const code = safeErrorCode(error);
        if (code === "runtime_provisioning_in_progress") throw error;
        failures.push(`${adapter.key}:${code}`);
        this.logger.warn("[runtime-manager] provider failed", { alias, provider: adapter.key, code });
        if (preferred) {
          await this.registry.markHealth(adapter.key, preferred.externalId, "failed", code, { failedBy: "runtime-manager" }).catch(() => undefined);
        }
      } finally {
        if (leaseAcquired) {
          await this.registry.releaseProvisioningLease(alias, adapter.key, holderId).catch((error) => {
            this.logger.warn("[runtime-manager] provisioning lease release failed", { alias, provider: adapter.key, code: safeErrorCode(error) });
          });
        }
      }
    }

    throw new Error(`runtime_capacity_unavailable:${failures.join(",").slice(0, 500)}`);
  }

  private remember(alias: RuntimeAlias, result: RuntimeManagerResult) {
    if (this.cacheMs <= 0) return;
    this.cache.set(alias, { result, expiresAt: Date.now() + this.cacheMs });
  }
}
