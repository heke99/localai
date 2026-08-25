type RunpodPod = {
  id?: string;
  desiredStatus?: "RUNNING" | "EXITED" | "TERMINATED" | string;
  lastStartedAt?: string | null;
};

export type RuntimeWakeResult = {
  configured: boolean;
  state: "unconfigured" | "healthy" | "starting" | "booting" | "restarting";
  desiredStatus?: string;
};

const DEFAULT_API_BASE = "https://rest.runpod.io/v1";
const DEFAULT_HEALTH_TIMEOUT_MS = 2_000;
const DEFAULT_API_TIMEOUT_MS = 5_000;
const DEFAULT_RUNNING_CACHE_MS = 15_000;
const DEFAULT_RESTART_GRACE_MS = 5 * 60_000;

let wakeInFlight: Promise<RuntimeWakeResult> | null = null;
let lastHealthyAt = 0;

function numericEnvironment(name: string, fallback: number) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function configuration() {
  const apiKey = process.env.RUNPOD_API_KEY?.trim();
  const podId = process.env.RUNPOD_POD_ID?.trim();
  if (!apiKey || !podId) return null;
  return {
    apiKey,
    podId,
    apiBase: process.env.RUNPOD_API_BASE_URL?.trim() || DEFAULT_API_BASE,
    healthUrl: process.env.RUNPOD_RUNTIME_HEALTH_URL?.trim() || `https://${podId}-8080.proxy.runpod.net/health`,
    restartUnhealthy: process.env.RUNPOD_RESTART_UNHEALTHY?.trim() === "1",
    apiTimeoutMs: numericEnvironment("RUNPOD_API_TIMEOUT_MS", DEFAULT_API_TIMEOUT_MS),
    healthTimeoutMs: numericEnvironment("RUNPOD_RUNTIME_HEALTH_TIMEOUT_MS", DEFAULT_HEALTH_TIMEOUT_MS),
    runningCacheMs: numericEnvironment("RUNPOD_RUNTIME_RUNNING_CACHE_MS", DEFAULT_RUNNING_CACHE_MS),
    restartGraceMs: numericEnvironment("RUNPOD_RUNTIME_RESTART_GRACE_MS", DEFAULT_RESTART_GRACE_MS)
  };
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(Math.max(250, timeoutMs)), cache: "no-store" });
}

async function runtimeHealthy(healthUrl: string, timeoutMs: number) {
  try {
    const response = await fetchWithTimeout(healthUrl, { method: "GET" }, timeoutMs);
    return response.ok;
  } catch {
    return false;
  }
}

async function runpodRequest(config: NonNullable<ReturnType<typeof configuration>>, path: string, method: "GET" | "POST") {
  const response = await fetchWithTimeout(`${config.apiBase}${path}`, {
    method,
    headers: { Authorization: `Bearer ${config.apiKey}` }
  }, config.apiTimeoutMs);
  if (!response.ok) throw new Error(`runpod_api_${method.toLowerCase()}_${response.status}`);
  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) as RunpodPod : null;
}

function startedRecently(lastStartedAt: string | null | undefined, graceMs: number) {
  if (!lastStartedAt) return false;
  const startedAt = new Date(lastStartedAt).getTime();
  return Number.isFinite(startedAt) && Date.now() - startedAt < graceMs;
}

async function performWake(): Promise<RuntimeWakeResult> {
  const config = configuration();
  if (!config) return { configured: false, state: "unconfigured" };

  if (Date.now() - lastHealthyAt < config.runningCacheMs) {
    return { configured: true, state: "healthy", desiredStatus: "RUNNING" };
  }

  if (await runtimeHealthy(config.healthUrl, config.healthTimeoutMs)) {
    lastHealthyAt = Date.now();
    return { configured: true, state: "healthy", desiredStatus: "RUNNING" };
  }

  const pod = await runpodRequest(config, `/pods/${encodeURIComponent(config.podId)}`, "GET");
  const desiredStatus = pod?.desiredStatus ?? "UNKNOWN";

  if (desiredStatus === "TERMINATED") throw new Error("runpod_pod_terminated");

  if (desiredStatus !== "RUNNING") {
    await runpodRequest(config, `/pods/${encodeURIComponent(config.podId)}/start`, "POST");
    return { configured: true, state: "starting", desiredStatus: "RUNNING" };
  }

  if (startedRecently(pod?.lastStartedAt, config.restartGraceMs)) {
    return { configured: true, state: "booting", desiredStatus };
  }

  if (config.restartUnhealthy) {
    await runpodRequest(config, `/pods/${encodeURIComponent(config.podId)}/restart`, "POST");
    return { configured: true, state: "restarting", desiredStatus: "RUNNING" };
  }

  return { configured: true, state: "booting", desiredStatus };
}

export function ensureRunpodRuntimeAwake() {
  if (!wakeInFlight) {
    wakeInFlight = performWake().finally(() => {
      wakeInFlight = null;
    });
  }
  return wakeInFlight;
}
