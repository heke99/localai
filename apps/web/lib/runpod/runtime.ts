type RunpodNetworkVolume = {
  id?: string;
  name?: string;
  dataCenterId?: string;
};

type RunpodGpu = {
  id?: string;
  count?: number;
  displayName?: string;
};

type RunpodMachine = {
  gpuTypeId?: string;
  gpuType?: RunpodGpu;
  dataCenterId?: string;
  supportPublicIp?: boolean;
};

type RunpodPod = {
  id?: string;
  name?: string;
  desiredStatus?: "RUNNING" | "EXITED" | "TERMINATED" | string;
  lastStartedAt?: string | null;
  image?: string;
  imageName?: string;
  containerDiskInGb?: number | null;
  dockerEntrypoint?: string[];
  dockerStartCmd?: string[];
  env?: Record<string, string>;
  gpu?: RunpodGpu;
  machine?: RunpodMachine;
  networkVolume?: RunpodNetworkVolume | null;
  ports?: string[];
  templateId?: string | null;
  volumeMountPath?: string;
  interruptible?: boolean;
  globalNetworking?: boolean;
};

type GraphqlResponse = {
  data?: { podResume?: RunpodPod | null };
  errors?: Array<{ message?: string }>;
};

export type RuntimeWakeResult = {
  configured: boolean;
  state: "unconfigured" | "healthy" | "starting" | "booting" | "restarting" | "replacing";
  desiredStatus?: string;
  podId?: string;
  replacement?: boolean;
};

const DEFAULT_API_BASE = "https://rest.runpod.io/v1";
const DEFAULT_GRAPHQL_URL = "https://api.runpod.io/graphql";
const DEFAULT_HEALTH_TIMEOUT_MS = 2_000;
const DEFAULT_API_TIMEOUT_MS = 5_000;
const DEFAULT_RUNNING_CACHE_MS = 15_000;
const DEFAULT_RESTART_GRACE_MS = 5 * 60_000;
const DEFAULT_START_ATTEMPTS = 3;
const DEFAULT_START_RETRY_BASE_MS = 500;
const DEFAULT_HEALTH_PORT = 8080;
const DEFAULT_HEALTH_PATH = "/health";
const RETRYABLE_RUNPOD_STATUSES = new Set([409, 423, 425, 429, 500, 502, 503, 504]);
const DEFAULT_48GB_FAILOVER_GPU_TYPES = [
  "NVIDIA L40S",
  "NVIDIA L40",
  "NVIDIA RTX A6000",
  "NVIDIA A40",
  "NVIDIA RTX 6000 Ada Generation"
] as const;

let wakeInFlight: Promise<RuntimeWakeResult> | null = null;
let lastHealthyAt = 0;
let lastHealthyPodId: string | null = null;

class RunpodApiError extends Error {
  constructor(
    readonly method: "GET" | "POST",
    readonly status: number,
    readonly path: string
  ) {
    super(`runpod_api_${method.toLowerCase()}_${status}`);
    this.name = "RunpodApiError";
  }
}

function numericEnvironment(name: string, fallback: number) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function positiveIntegerEnvironment(name: string, fallback: number) {
  const value = numericEnvironment(name, fallback);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function optionalPositiveIntegerEnvironment(name: string) {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function csvEnvironment(name: string) {
  return (process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function configuration() {
  const apiKey = process.env.RUNPOD_API_KEY?.trim();
  const podId = process.env.RUNPOD_POD_ID?.trim();
  if (!apiKey || !podId) return null;
  return {
    apiKey,
    podId,
    apiBase: process.env.RUNPOD_API_BASE_URL?.trim() || DEFAULT_API_BASE,
    graphqlUrl: process.env.RUNPOD_GRAPHQL_API_URL?.trim() || DEFAULT_GRAPHQL_URL,
    primaryHealthUrl: process.env.RUNPOD_RUNTIME_HEALTH_URL?.trim() || null,
    healthPort: positiveIntegerEnvironment("RUNPOD_RUNTIME_HEALTH_PORT", DEFAULT_HEALTH_PORT),
    healthPath: process.env.RUNPOD_RUNTIME_HEALTH_PATH?.trim() || DEFAULT_HEALTH_PATH,
    restartUnhealthy: process.env.RUNPOD_RESTART_UNHEALTHY?.trim() === "1",
    autoReplaceUnavailable: process.env.RUNPOD_AUTO_REPLACE_UNAVAILABLE?.trim() !== "0",
    networkVolumeId: process.env.RUNPOD_NETWORK_VOLUME_ID?.trim() || null,
    failoverTemplateId: process.env.RUNPOD_FAILOVER_TEMPLATE_ID?.trim() || null,
    failoverGpuCount: optionalPositiveIntegerEnvironment("RUNPOD_FAILOVER_GPU_COUNT"),
    failoverGpuTypeIds: csvEnvironment("RUNPOD_FAILOVER_GPU_TYPE_IDS"),
    runtimeFamilyName: process.env.RUNPOD_RUNTIME_FAMILY_NAME?.trim() || null,
    apiTimeoutMs: numericEnvironment("RUNPOD_API_TIMEOUT_MS", DEFAULT_API_TIMEOUT_MS),
    healthTimeoutMs: numericEnvironment("RUNPOD_RUNTIME_HEALTH_TIMEOUT_MS", DEFAULT_HEALTH_TIMEOUT_MS),
    runningCacheMs: numericEnvironment("RUNPOD_RUNTIME_RUNNING_CACHE_MS", DEFAULT_RUNNING_CACHE_MS),
    restartGraceMs: numericEnvironment("RUNPOD_RUNTIME_RESTART_GRACE_MS", DEFAULT_RESTART_GRACE_MS),
    startAttempts: positiveIntegerEnvironment("RUNPOD_START_ATTEMPTS", DEFAULT_START_ATTEMPTS),
    startRetryBaseMs: numericEnvironment("RUNPOD_START_RETRY_BASE_MS", DEFAULT_START_RETRY_BASE_MS)
  };
}

type RuntimeConfig = NonNullable<ReturnType<typeof configuration>>;

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(Math.max(250, timeoutMs)), cache: "no-store" });
}

function healthUrlForPod(config: RuntimeConfig, podId: string) {
  if (podId === config.podId && config.primaryHealthUrl) return config.primaryHealthUrl;
  const path = config.healthPath.startsWith("/") ? config.healthPath : `/${config.healthPath}`;
  return `https://${podId}-${config.healthPort}.proxy.runpod.net${path}`;
}

async function runtimeHealthy(healthUrl: string, timeoutMs: number) {
  try {
    const response = await fetchWithTimeout(healthUrl, { method: "GET" }, timeoutMs);
    return response.ok;
  } catch {
    return false;
  }
}

async function runpodRequest<T>(config: RuntimeConfig, path: string, method: "GET" | "POST", body?: unknown): Promise<T | null> {
  const headers: Record<string, string> = { Authorization: `Bearer ${config.apiKey}` };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  const response = await fetchWithTimeout(`${config.apiBase}${path}`, init, config.apiTimeoutMs);
  if (!response.ok) throw new RunpodApiError(method, response.status, path);
  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) as T : null;
}

function startedRecently(lastStartedAt: string | null | undefined, graceMs: number) {
  if (!lastStartedAt) return false;
  const startedAt = new Date(lastStartedAt).getTime();
  return Number.isFinite(startedAt) && Date.now() - startedAt < graceMs;
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function explicitGpuCount(pod: RunpodPod | null | undefined) {
  const value = pod?.gpu?.count ?? pod?.machine?.gpuType?.count;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sourceGpuId(pod: RunpodPod) {
  return pod.gpu?.id ?? pod.machine?.gpuTypeId ?? pod.machine?.gpuType?.id ?? null;
}

function sourceGpuCount(pod: RunpodPod) {
  return explicitGpuCount(pod) ?? 1;
}

function runtimeFamilyName(config: RuntimeConfig, source: RunpodPod) {
  const raw = config.runtimeFamilyName || source.name || "div3rsa-localai";
  return raw.replace(/-failover-[a-z0-9]+$/i, "").slice(0, 150);
}

function networkVolumeId(config: RuntimeConfig, source: RunpodPod) {
  return config.networkVolumeId || source.networkVolume?.id || null;
}

function failoverGpuTypes(config: RuntimeConfig, source: RunpodPod, gpuCount: number) {
  const sourceId = sourceGpuId(source);
  const configured = config.failoverGpuTypeIds;
  const candidates = configured.length
    ? [sourceId, ...configured]
    : gpuCount >= 2 || (sourceId ? DEFAULT_48GB_FAILOVER_GPU_TYPES.includes(sourceId as typeof DEFAULT_48GB_FAILOVER_GPU_TYPES[number]) : false)
      ? [sourceId, ...DEFAULT_48GB_FAILOVER_GPU_TYPES]
      : [sourceId];
  return [...new Set(candidates.filter((value): value is string => Boolean(value)))];
}

async function getPod(config: RuntimeConfig, podId: string) {
  return runpodRequest<RunpodPod>(config, `/pods/${encodeURIComponent(podId)}`, "GET");
}

async function podIsRunning(config: RuntimeConfig, podId: string) {
  try {
    const pod = await getPod(config, podId);
    const gpuCount = explicitGpuCount(pod);
    return pod?.desiredStatus === "RUNNING" && gpuCount !== 0;
  } catch {
    return false;
  }
}

async function resumeViaGraphql(config: RuntimeConfig, podId: string, gpuCount: number) {
  const query = `mutation { podResume(input: { podId: ${JSON.stringify(podId)}, gpuCount: ${gpuCount} }) { id desiredStatus } }`;
  const response = await fetchWithTimeout(`${config.graphqlUrl}?api_key=${encodeURIComponent(config.apiKey)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query })
  }, config.apiTimeoutMs);

  if (!response.ok) throw new Error(`runpod_graphql_http_${response.status}`);
  const payload = await response.json() as GraphqlResponse;
  if (payload.errors?.length) throw new Error("runpod_graphql_resume_failed");
  if (!payload.data?.podResume) throw new Error("runpod_graphql_resume_empty");
  return payload.data.podResume;
}

async function startStoppedPod(config: RuntimeConfig, podId: string, gpuCount: number) {
  const path = `/pods/${encodeURIComponent(podId)}/start`;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= config.startAttempts; attempt += 1) {
    try {
      await runpodRequest<RunpodPod>(config, path, "POST");
      return;
    } catch (error) {
      lastError = error;
      if (!(error instanceof RunpodApiError) || !RETRYABLE_RUNPOD_STATUSES.has(error.status)) throw error;

      if (await podIsRunning(config, podId)) return;
      if (attempt < config.startAttempts) await delay(config.startRetryBaseMs * attempt);
    }
  }

  try {
    await resumeViaGraphql(config, podId, gpuCount);
    return;
  } catch (graphqlError) {
    if (await podIsRunning(config, podId)) return;
    throw lastError ?? graphqlError;
  }
}

async function listPods(config: RuntimeConfig) {
  return await runpodRequest<RunpodPod[]>(config, "/pods?includeMachine=true&includeNetworkVolume=true", "GET") ?? [];
}

async function findManagedReplacement(config: RuntimeConfig, source: RunpodPod) {
  const volumeId = networkVolumeId(config, source);
  const family = runtimeFamilyName(config, source);
  const prefix = `${family}-failover-`;
  const pods = await listPods(config);

  return pods
    .filter((pod) => pod.id && pod.id !== source.id && pod.desiredStatus !== "TERMINATED")
    .filter((pod) => !volumeId || pod.networkVolume?.id === volumeId)
    .filter((pod) => pod.name?.startsWith(prefix))
    .sort((left, right) => {
      const leftRunning = left.desiredStatus === "RUNNING" ? 1 : 0;
      const rightRunning = right.desiredStatus === "RUNNING" ? 1 : 0;
      if (leftRunning !== rightRunning) return rightRunning - leftRunning;
      return new Date(right.lastStartedAt ?? 0).getTime() - new Date(left.lastStartedAt ?? 0).getTime();
    })[0] ?? null;
}

function replacementCreateBody(config: RuntimeConfig, source: RunpodPod) {
  const volumeId = networkVolumeId(config, source);
  if (!volumeId) throw new Error("runpod_failover_network_volume_required");

  const gpuCount = config.failoverGpuCount ?? sourceGpuCount(source);
  const gpuTypeIds = failoverGpuTypes(config, source, gpuCount);
  if (!gpuTypeIds.length) throw new Error("runpod_failover_gpu_profile_missing");

  const family = runtimeFamilyName(config, source);
  const name = `${family}-failover-${Date.now().toString(36)}`.slice(0, 191);
  const dataCenterId = source.networkVolume?.dataCenterId;
  const templateId = config.failoverTemplateId || source.templateId || null;
  const base: Record<string, unknown> = {
    name,
    cloudType: "SECURE",
    computeType: "GPU",
    gpuCount,
    gpuTypeIds,
    gpuTypePriority: "availability",
    networkVolumeId: volumeId,
    volumeMountPath: source.volumeMountPath || "/workspace",
    interruptible: false,
    supportPublicIp: source.machine?.supportPublicIp ?? true
  };

  if (dataCenterId) {
    base.dataCenterIds = [dataCenterId];
    base.dataCenterPriority = "availability";
  }

  if (templateId) {
    base.templateId = templateId;
    return base;
  }

  const imageName = source.image || source.imageName;
  if (!imageName) throw new Error("runpod_failover_image_required");
  base.imageName = imageName;
  base.containerDiskInGb = source.containerDiskInGb ?? 50;
  base.dockerEntrypoint = source.dockerEntrypoint ?? [];
  base.dockerStartCmd = source.dockerStartCmd ?? [];
  base.env = source.env ?? {};
  base.ports = source.ports?.length ? source.ports : ["8080/http", "22/tcp"];
  base.globalNetworking = source.globalNetworking ?? false;
  return base;
}

async function createReplacement(config: RuntimeConfig, source: RunpodPod) {
  const existing = await findManagedReplacement(config, source);
  if (existing?.id) return existing;

  const body = replacementCreateBody(config, source);
  const created = await runpodRequest<RunpodPod>(config, "/pods", "POST", body);
  if (!created?.id) throw new Error("runpod_failover_create_empty");
  return created;
}

async function useExistingReplacement(config: RuntimeConfig, source: RunpodPod): Promise<RuntimeWakeResult | null> {
  if (!config.autoReplaceUnavailable) return null;
  const replacement = await findManagedReplacement(config, source);
  if (!replacement?.id) return null;

  if (await runtimeHealthy(healthUrlForPod(config, replacement.id), config.healthTimeoutMs)) {
    lastHealthyAt = Date.now();
    lastHealthyPodId = replacement.id;
    return { configured: true, state: "healthy", desiredStatus: "RUNNING", podId: replacement.id, replacement: true };
  }

  if (replacement.desiredStatus !== "RUNNING") {
    try {
      await startStoppedPod(config, replacement.id, sourceGpuCount(replacement));
      return { configured: true, state: "starting", desiredStatus: "RUNNING", podId: replacement.id, replacement: true };
    } catch {
      return null;
    }
  }

  return {
    configured: true,
    state: startedRecently(replacement.lastStartedAt, config.restartGraceMs) ? "booting" : "booting",
    desiredStatus: "RUNNING",
    podId: replacement.id,
    replacement: true
  };
}

async function replaceUnavailablePod(config: RuntimeConfig, source: RunpodPod): Promise<RuntimeWakeResult> {
  if (!config.autoReplaceUnavailable) throw new Error("runpod_pod_unavailable");
  const replacement = await createReplacement(config, source);
  return {
    configured: true,
    state: "replacing",
    desiredStatus: replacement.desiredStatus ?? "RUNNING",
    podId: replacement.id,
    replacement: true
  };
}

async function performWake(): Promise<RuntimeWakeResult> {
  const config = configuration();
  if (!config) return { configured: false, state: "unconfigured" };

  if (lastHealthyPodId && Date.now() - lastHealthyAt < config.runningCacheMs) {
    return { configured: true, state: "healthy", desiredStatus: "RUNNING", podId: lastHealthyPodId, replacement: lastHealthyPodId !== config.podId };
  }

  if (await runtimeHealthy(healthUrlForPod(config, config.podId), config.healthTimeoutMs)) {
    lastHealthyAt = Date.now();
    lastHealthyPodId = config.podId;
    return { configured: true, state: "healthy", desiredStatus: "RUNNING", podId: config.podId, replacement: false };
  }

  const pod = await getPod(config, config.podId);
  if (!pod) throw new Error("runpod_pod_not_found");
  const desiredStatus = pod.desiredStatus ?? "UNKNOWN";
  const gpuCount = explicitGpuCount(pod);

  if (desiredStatus !== "RUNNING") {
    const existingReplacement = await useExistingReplacement(config, pod);
    if (existingReplacement) return existingReplacement;
  }

  if (desiredStatus === "TERMINATED") {
    return replaceUnavailablePod(config, pod);
  }

  if (desiredStatus !== "RUNNING") {
    try {
      await startStoppedPod(config, config.podId, sourceGpuCount(pod));
      return { configured: true, state: "starting", desiredStatus: "RUNNING", podId: config.podId, replacement: false };
    } catch (error) {
      if (!(error instanceof RunpodApiError) || !RETRYABLE_RUNPOD_STATUSES.has(error.status)) throw error;
      return replaceUnavailablePod(config, pod);
    }
  }

  // Runpod can report RUNNING after resume while assigning zero GPUs when the
  // original host capacity is gone. Treat that as unavailable instead of
  // leaving queued agent runs waiting on a runtime that cannot load the model.
  if (gpuCount === 0) {
    return replaceUnavailablePod(config, pod);
  }

  if (startedRecently(pod.lastStartedAt, config.restartGraceMs)) {
    return { configured: true, state: "booting", desiredStatus, podId: config.podId, replacement: false };
  }

  if (config.restartUnhealthy) {
    await runpodRequest<RunpodPod>(config, `/pods/${encodeURIComponent(config.podId)}/restart`, "POST");
    return { configured: true, state: "restarting", desiredStatus: "RUNNING", podId: config.podId, replacement: false };
  }

  return { configured: true, state: "booting", desiredStatus, podId: config.podId, replacement: false };
}

export function ensureRunpodRuntimeAwake() {
  if (!wakeInFlight) {
    wakeInFlight = performWake().finally(() => {
      wakeInFlight = null;
    });
  }
  return wakeInFlight;
}
