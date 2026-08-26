type RpcError = { code?: string; message?: string };
export type RuntimeRpcClient = {
  rpc<T>(name: string, args: Record<string, unknown>): Promise<{ data: T | null; error: RpcError | null }>;
};

export type RuntimeRegistrationConfig = {
  providerKey: string;
  providerKind: "managed" | "static";
  providerPriority: number;
  externalId: string;
  profile: string;
  aliases: string[];
  endpoint: string;
  healthUrl: string | null;
  region: string | null;
  gpuType: string | null;
  gpuCount: number | null;
  vramTotalBytes: number | null;
};

function integer(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function optionalInteger(value: string | undefined) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function validUrl(value: string | undefined) {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) return null;
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname))) return null;
    return value.replace(/\/$/, "");
  } catch {
    return null;
  }
}

function aliases() {
  return [...new Set((process.env.DIV3RSA_RUNTIME_ALIASES || "general-prod,code-prod,lab-prod,research-prod")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => /^[a-z0-9][a-z0-9_-]{0,159}$/.test(value)))];
}

export function runtimeRegistrationConfigFromEnvironment(modelPort: number): RuntimeRegistrationConfig | null {
  const runpodId = process.env.RUNPOD_POD_ID?.trim() || null;
  const providerKey = process.env.DIV3RSA_RUNTIME_PROVIDER?.trim() || (runpodId ? "runpod" : "");
  const externalId = process.env.DIV3RSA_RUNTIME_EXTERNAL_ID?.trim() || runpodId || "";
  if (!providerKey || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(providerKey) || !externalId || externalId.length > 512) return null;

  const derivedRunpodEndpoint = runpodId ? `https://${runpodId}-${modelPort}.proxy.runpod.net/v1` : undefined;
  const derivedRunpodHealth = runpodId ? `https://${runpodId}-${modelPort}.proxy.runpod.net/health` : undefined;
  const endpoint = validUrl(process.env.DIV3RSA_RUNTIME_PUBLIC_ENDPOINT?.trim() || derivedRunpodEndpoint);
  const healthUrl = validUrl(process.env.DIV3RSA_RUNTIME_PUBLIC_HEALTH_URL?.trim() || derivedRunpodHealth);
  if (!endpoint) return null;

  const providerKind = process.env.DIV3RSA_RUNTIME_PROVIDER_KIND?.trim() === "static" ? "static" : "managed";
  const providerPriority = Math.min(10000, Math.max(0, integer(process.env.DIV3RSA_RUNTIME_PROVIDER_PRIORITY, providerKey === "runpod" ? 100 : 500)));
  const gpuCount = optionalInteger(process.env.DIV3RSA_RUNTIME_GPU_COUNT || process.env.RUNPOD_FAILOVER_GPU_COUNT);
  const vramGb = Number(process.env.DIV3RSA_RUNTIME_VRAM_GB ?? "");
  const targetAliases = aliases();
  if (!targetAliases.length) return null;

  return {
    providerKey,
    providerKind,
    providerPriority,
    externalId,
    profile: process.env.DIV3RSA_RUNTIME_PROFILE?.trim() || "large_96gb",
    aliases: targetAliases,
    endpoint,
    healthUrl,
    region: process.env.DIV3RSA_RUNTIME_REGION?.trim() || null,
    gpuType: process.env.DIV3RSA_RUNTIME_GPU_TYPE?.trim() || null,
    gpuCount,
    vramTotalBytes: Number.isFinite(vramGb) && vramGb >= 0 ? Math.round(vramGb * 1024 ** 3) : null
  };
}

function rolloutMissing(error: RpcError | null) {
  return Boolean(error && (error.code === "PGRST202" || /runtime_(register_worker|worker_heartbeat)|could not find the function/i.test(error.message ?? "")));
}

export class RuntimeRegistration {
  private registered = false;

  constructor(
    private readonly client: RuntimeRpcClient,
    private readonly config: RuntimeRegistrationConfig,
    private readonly workerId: string
  ) {}

  async sync() {
    if (!this.registered) {
      for (const alias of this.config.aliases) {
        const { error } = await this.client.rpc<string>("runtime_register_worker", {
          target_provider_key: this.config.providerKey,
          target_provider_kind: this.config.providerKind,
          target_provider_priority: this.config.providerPriority,
          target_external_worker_id: this.config.externalId,
          target_profile: this.config.profile,
          target_state: "ready",
          target_model_alias: alias,
          target_endpoint: this.config.endpoint,
          target_health_url: this.config.healthUrl,
          target_region: this.config.region,
          target_gpu_type: this.config.gpuType,
          target_gpu_count: this.config.gpuCount,
          target_vram_total_bytes: this.config.vramTotalBytes,
          target_route_priority: 100,
          target_metadata: { source: "agent-worker", workerId: this.workerId, runtimeContract: "div3rsa-runtime-v1" }
        });
        if (error) {
          if (rolloutMissing(error)) return false;
          throw new Error(`runtime_registration_failed:${error.code ?? "unknown"}`);
        }
      }
      this.registered = true;
    }

    const { data, error } = await this.client.rpc<boolean>("runtime_worker_heartbeat", {
      target_provider_key: this.config.providerKey,
      target_external_worker_id: this.config.externalId,
      target_metadata: { workerId: this.workerId, runtimeContract: "div3rsa-runtime-v1" }
    });
    if (error) {
      if (rolloutMissing(error)) {
        this.registered = false;
        return false;
      }
      throw new Error(`runtime_heartbeat_failed:${error.code ?? "unknown"}`);
    }
    if (data !== true) {
      this.registered = false;
      return false;
    }
    return true;
  }
}
