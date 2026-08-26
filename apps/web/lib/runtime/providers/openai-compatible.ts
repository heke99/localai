import type { RegisteredRuntimeRoute, RuntimeEnsureRequest, RuntimeInstance, RuntimeProviderAdapter } from "../contracts";

function providerKey() {
  const value = process.env.GENERIC_RUNTIME_PROVIDER_KEY?.trim() || "generic-openai";
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)) throw new Error("generic_runtime_provider_key_invalid");
  return value;
}

function baseUrl() {
  const value = process.env.GENERIC_RUNTIME_BASE_URL?.trim();
  if (!value) return null;
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error("generic_runtime_url_invalid"); }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("generic_runtime_url_must_not_contain_credentials");
  const local = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "::1";
  if (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) throw new Error("generic_runtime_https_required");
  return value.replace(/\/$/, "");
}

function apiKey() {
  return process.env.GENERIC_RUNTIME_API_KEY?.trim() || process.env.QWEN_INFERENCE_API_KEY?.trim() || "";
}

function healthUrl(endpoint: string) {
  return process.env.GENERIC_RUNTIME_HEALTH_URL?.trim() || `${endpoint}/models`;
}

async function probe(url: string, token: string) {
  try {
    const timeout = Number(process.env.GENERIC_RUNTIME_HEALTH_TIMEOUT_MS ?? "3000");
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await fetch(url, {
      method: "GET",
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(Number.isFinite(timeout) && timeout > 0 ? timeout : 3000)
    });
    return response.ok;
  } catch {
    return false;
  }
}

export class OpenAiCompatibleRuntimeProvider implements RuntimeProviderAdapter {
  readonly kind = "static" as const;
  readonly defaultPriority = 500;

  get key() {
    return providerKey();
  }

  configured() {
    return Boolean(baseUrl());
  }

  async health(route: RegisteredRuntimeRoute) {
    const configuredEndpoint = baseUrl();
    if (!configuredEndpoint || route.endpoint !== configuredEndpoint) return false;
    return probe(route.healthUrl || healthUrl(configuredEndpoint), apiKey());
  }

  async ensure(request: RuntimeEnsureRequest): Promise<RuntimeInstance> {
    const endpoint = baseUrl();
    if (!endpoint) throw new Error("generic_runtime_unconfigured");
    const targetHealthUrl = healthUrl(endpoint);
    if (!(await probe(targetHealthUrl, apiKey()))) throw new Error("generic_runtime_unhealthy");

    const externalId = process.env.GENERIC_RUNTIME_EXTERNAL_ID?.trim() || `${new URL(endpoint).hostname}:${new URL(endpoint).port || "443"}`;
    if (externalId.length > 512) throw new Error("generic_runtime_external_id_invalid");

    const gpuCountValue = Number(process.env.GENERIC_RUNTIME_GPU_COUNT ?? "");
    const vramGbValue = Number(process.env.GENERIC_RUNTIME_VRAM_GB ?? "");
    return {
      providerKey: this.key,
      providerKind: this.kind,
      providerPriority: this.defaultPriority,
      externalId,
      profile: request.profile,
      state: "ready",
      endpoint,
      healthUrl: targetHealthUrl,
      region: process.env.GENERIC_RUNTIME_REGION?.trim() || null,
      gpuType: process.env.GENERIC_RUNTIME_GPU_TYPE?.trim() || null,
      gpuCount: Number.isInteger(gpuCountValue) && gpuCountValue >= 0 ? gpuCountValue : null,
      vramTotalBytes: Number.isFinite(vramGbValue) && vramGbValue >= 0 ? Math.round(vramGbValue * 1024 ** 3) : null,
      routePriority: 100,
      metadata: { adapter: "openai-compatible", lifecycle: "externally-managed" }
    };
  }
}
