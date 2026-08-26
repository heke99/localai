import "server-only";
import { createSupabaseAdminClient } from "../supabase/admin";
import type {
  EnabledRuntimeProvider,
  RegisteredRuntimeRoute,
  RuntimeAlias,
  RuntimeInstance,
  RuntimeRegistry,
  RuntimeState
} from "./contracts";

type RpcError = { code?: string; message?: string };
type RpcResponse<T> = Promise<{ data: T | null; error: RpcError | null }>;
type RuntimeRpcClient = { rpc<T>(name: string, args?: Record<string, unknown>): RpcResponse<T> };

function rolloutMissing(error: RpcError | null) {
  return Boolean(error && (error.code === "PGRST202" || /runtime_(enabled_providers|resolve_model_routes|register_worker|mark_worker_health|acquire_provisioning_lease|release_provisioning_lease)|could not find the function/i.test(error.message ?? "")));
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && !Array.isArray(value) && typeof value === "object" ? value as Record<string, unknown> : {};
}

function numberValue(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nullableNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function runtimeState(value: unknown): RuntimeState {
  if (value === "provisioning" || value === "warming" || value === "ready" || value === "draining" || value === "stopped" || value === "failed") return value;
  return "failed";
}

export class SupabaseRuntimeRegistry implements RuntimeRegistry {
  private readonly client = createSupabaseAdminClient() as unknown as RuntimeRpcClient;

  async enabledProviders(): Promise<EnabledRuntimeProvider[]> {
    const { data, error } = await this.client.rpc<Array<Record<string, unknown>>>("runtime_enabled_providers");
    if (error) {
      if (rolloutMissing(error)) return [];
      throw new Error(`runtime_registry_provider_catalog_failed:${error.code ?? "unknown"}`);
    }
    return (data ?? []).flatMap((row) => {
      const key = typeof row.provider_key === "string" ? row.provider_key : "";
      const kind = row.provider_kind === "static" ? "static" : row.provider_kind === "managed" ? "managed" : null;
      if (!key || !kind) return [];
      return [{ key, kind, priority: numberValue(row.provider_priority, 100), configuration: objectValue(row.configuration) }];
    });
  }

  async resolve(alias: RuntimeAlias): Promise<RegisteredRuntimeRoute[]> {
    const { data, error } = await this.client.rpc<Array<Record<string, unknown>>>("runtime_resolve_model_routes", { target_alias: alias });
    if (error) {
      if (rolloutMissing(error)) return [];
      throw new Error(`runtime_registry_resolve_failed:${error.code ?? "unknown"}`);
    }

    return (data ?? []).flatMap((row) => {
      const providerKey = typeof row.provider_key === "string" ? row.provider_key : "";
      const externalId = typeof row.external_worker_id === "string" ? row.external_worker_id : "";
      const endpoint = typeof row.endpoint === "string" ? row.endpoint : "";
      const workerId = typeof row.worker_id === "string" ? row.worker_id : "";
      const providerKind = row.provider_kind === "static" ? "static" : row.provider_kind === "managed" ? "managed" : null;
      if (!providerKey || !externalId || !endpoint || !workerId || !providerKind) return [];
      return [{
        providerKey,
        providerKind,
        providerPriority: numberValue(row.provider_priority, 100),
        workerId,
        externalId,
        state: runtimeState(row.worker_state),
        endpoint,
        healthUrl: typeof row.health_url === "string" ? row.health_url : null,
        profile: typeof row.profile === "string" ? row.profile : "large_96gb",
        region: typeof row.region === "string" ? row.region : null,
        gpuType: typeof row.gpu_type === "string" ? row.gpu_type : null,
        gpuCount: nullableNumber(row.gpu_count),
        vramTotalBytes: nullableNumber(row.vram_total_bytes),
        routePriority: numberValue(row.route_priority, 100),
        routeWeight: numberValue(row.route_weight, 1),
        lastHealthAt: typeof row.last_health_at === "string" ? row.last_health_at : null,
        updatedAt: typeof row.updated_at === "string" ? row.updated_at : new Date(0).toISOString(),
        metadata: objectValue(row.metadata)
      }];
    });
  }

  async register(alias: RuntimeAlias, instance: RuntimeInstance): Promise<string> {
    const { data, error } = await this.client.rpc<string>("runtime_register_worker", {
      target_provider_key: instance.providerKey,
      target_provider_kind: instance.providerKind,
      target_provider_priority: instance.providerPriority,
      target_external_worker_id: instance.externalId,
      target_profile: instance.profile,
      target_state: instance.state,
      target_model_alias: alias,
      target_endpoint: instance.endpoint,
      target_health_url: instance.healthUrl ?? null,
      target_region: instance.region ?? null,
      target_gpu_type: instance.gpuType ?? null,
      target_gpu_count: instance.gpuCount ?? null,
      target_vram_total_bytes: instance.vramTotalBytes ?? null,
      target_route_priority: instance.routePriority ?? 100,
      target_metadata: instance.metadata ?? {}
    });
    if (error) {
      if (rolloutMissing(error)) return "rollout-fallback";
      throw new Error(`runtime_registry_register_failed:${error.code ?? "unknown"}:${error.message ?? "unknown"}`);
    }
    if (typeof data !== "string" || !data) throw new Error("runtime_registry_register_empty");
    return data;
  }

  async markHealth(providerKey: string, externalId: string, state: RuntimeState, errorCode: string | null = null, metadata?: Record<string, unknown>): Promise<void> {
    const { error } = await this.client.rpc<boolean>("runtime_mark_worker_health", {
      target_provider_key: providerKey,
      target_external_worker_id: externalId,
      target_state: state,
      target_last_error_code: errorCode,
      target_metadata: metadata ?? null
    });
    if (error) {
      if (rolloutMissing(error)) return;
      throw new Error(`runtime_registry_health_failed:${error.code ?? "unknown"}`);
    }
  }

  async acquireProvisioningLease(alias: RuntimeAlias, providerKey: string, holderId: string, ttlSeconds = 120): Promise<boolean> {
    const { data, error } = await this.client.rpc<boolean>("runtime_acquire_provisioning_lease", {
      target_alias: alias,
      target_provider_key: providerKey,
      target_holder_id: holderId,
      target_ttl_seconds: ttlSeconds
    });
    if (error) {
      // During a staggered web/DB rollout, preserve the old in-process behavior
      // until the migration lands rather than taking run submission down.
      if (rolloutMissing(error)) return true;
      throw new Error(`runtime_registry_lease_acquire_failed:${error.code ?? "unknown"}`);
    }
    return data === true;
  }

  async releaseProvisioningLease(alias: RuntimeAlias, providerKey: string, holderId: string): Promise<void> {
    const { error } = await this.client.rpc<boolean>("runtime_release_provisioning_lease", {
      target_alias: alias,
      target_provider_key: providerKey,
      target_holder_id: holderId
    });
    if (error && !rolloutMissing(error)) throw new Error(`runtime_registry_lease_release_failed:${error.code ?? "unknown"}`);
  }
}
