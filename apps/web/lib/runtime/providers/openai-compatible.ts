import type { RegisteredRuntimeRoute, RuntimeEnsureRequest, RuntimeInstance, RuntimeProviderAdapter } from "../contracts";

const RUNTIME_CONTRACT = "div3rsa-runtime-v1";

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

function contractConfigured() {
  return process.env.GENERIC_RUNTIME_CONTRACT?.trim() === RUNTIME_CONTRACT;
}

function apiKey() {
  return process.env.GENERIC_RUNTIME_API_KEY?.trim()
    || process.env.DIV3RSA_INFERENCE_API_KEY?.trim()
    || process.env.QWEN_INFERENCE_API_KEY?.trim()
    || "";
}

function healthUrl(endpoint: string) {
  const explicit = process.env.GENERIC_RUNTIME_HEALTH_URL?.trim();
  if (explicit) return explicit;
  const parsed = new URL(endpoint);
  parsed.pathname = parsed.pathname.replace(/\/v1\/?$/, "").replace(/\/$/, "") + "/health";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
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
    return Boolean(baseUrl() && contractConfigured());
  }

  async health(route: RegisteredRuntimeRoute) {
    const configuredEndpoint = baseUrl();
    if (!configuredEndpoint || !contractConfigured() || route.endpoint !== configuredEndpoint) return false;
    return probe(route.healthUrl || healthUrl(configuredEndpoint), apiKey());
  }

  async ensure(request: RuntimeEnsureRequest): Promise<RuntimeInstance> {
    const endpoint = baseUrl();
    if (!endpoint || !contractConfigured()) throw new Error("generic_runtime_contract_required");
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
      // A healthy inference endpoint is still warming until its agent worker
      // registers/heartbeats, unless an operator explicitly attests that an
      // external supervisor implements the complete runtime contract.
      state: process.env.GENERIC_RUNTIME_ASSUME_READY?.trim() === "1" ? "ready" : "warming",
      endpoint,
      healthUrl: targetHealthUrl,
      region: process.env.GENERIC_RUNTIME_REGION?.trim() || null,
      gpuType: process.env.GENERIC_RUNTIME_GPU_TYPE?.trim() || null,
      gpuCount: Number.isInteger(gpuCountValue) && gpuCountValue >= 0 ? gpuCountValue : null,
      vramTotalBytes: Number.isFinite(vramGbValue) && vramGbValue >= 0 ? Math.round(vramGbValue * 1024 ** 3) : null,
      routePriority: 100,
      metadata: { adapter: "openai-compatible", lifecycle: "externally-managed", contract: RUNTIME_CONTRACT }
    };
  }
}
