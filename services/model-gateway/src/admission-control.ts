type Fetch = typeof fetch;

export type AdmissionAction = "admit" | "defer" | "reject";

export interface ModelTimingObservation {
  tokensPerSecond?: number | null;
  ttftMs?: number | null;
  interTokenLatencyMs?: number | null;
}

export interface AdmissionSnapshot {
  activeSequences: number | null;
  queueDepth: number | null;
  kvCacheUsageRatio: number | null;
  tokensPerSecond: number | null;
  ttftMs: number | null;
  interTokenLatencyMs: number | null;
  gpuUtilizationRatio: number | null;
  vramUsageRatio: number | null;
  requestContextTokens: number;
  contextHighWatermarkTokens: number | null;
  contextLimit: number;
  batchSize: number;
  telemetryAvailable: boolean;
}

export interface AdmissionDecision {
  action: AdmissionAction;
  reason: string;
  snapshot: AdmissionSnapshot;
}

export interface AdmissionController {
  waitForAdmission(contextTokens: number, signal?: AbortSignal): Promise<AdmissionSnapshot>;
  observeTimings(observation: ModelTimingObservation): void;
}

export interface LlamaCppAdmissionOptions {
  contextLimit?: number;
  batchSize?: number;
  maxActiveSequences?: number;
  maxDeferredRequests?: number;
  maxKvCacheUsageRatio?: number;
  minTokensPerSecond?: number;
  maxTtftMs?: number;
  maxInterTokenLatencyMs?: number;
  maxGpuUtilizationRatio?: number;
  maxVramUsageRatio?: number;
  maxContextHighWatermarkRatio?: number;
  pollIntervalMs?: number;
  maxWaitMs?: number;
  telemetryTimeoutMs?: number;
  gpuMetricsUrl?: string | null;
}

type ResolvedOptions = Required<Omit<LlamaCppAdmissionOptions, "gpuMetricsUrl">> & { gpuMetricsUrl: string | null };

type MetricMap = Map<string, number[]>;

const DEFAULTS: ResolvedOptions = {
  contextLimit: 32768,
  batchSize: 2048,
  maxActiveSequences: 4,
  maxDeferredRequests: 4,
  maxKvCacheUsageRatio: 0.9,
  minTokensPerSecond: 8,
  maxTtftMs: 5000,
  maxInterTokenLatencyMs: 125,
  maxGpuUtilizationRatio: 0.98,
  maxVramUsageRatio: 0.94,
  maxContextHighWatermarkRatio: 0.95,
  pollIntervalMs: 250,
  maxWaitMs: 30000,
  telemetryTimeoutMs: 1000,
  gpuMetricsUrl: null
};

function positive(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`invalid_admission_option:${name}`);
  return value;
}

function ratio(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0 || value > 1) throw new Error(`invalid_admission_ratio:${name}`);
  return value;
}

function parsePrometheus(text: string): MetricMap {
  const metrics: MetricMap = new Map();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const whitespace = line.search(/\s/);
    if (whitespace <= 0) continue;
    const metricWithLabels = line.slice(0, whitespace);
    const metric = metricWithLabels.replace(/\{.*$/, "");
    const rawValue = line.slice(whitespace).trim().split(/\s+/)[0];
    const value = Number(rawValue);
    if (!metric || !Number.isFinite(value)) continue;
    const values = metrics.get(metric) ?? [];
    values.push(value);
    metrics.set(metric, values);
  }
  return metrics;
}

function values(metrics: MetricMap, ...names: string[]): number[] {
  for (const name of names) {
    const found = metrics.get(name);
    if (found?.length) return found;
  }
  return [];
}

function sum(metrics: MetricMap, ...names: string[]): number | null {
  const found = values(metrics, ...names);
  return found.length ? found.reduce((total, value) => total + value, 0) : null;
}

function max(metrics: MetricMap, ...names: string[]): number | null {
  const found = values(metrics, ...names);
  return found.length ? Math.max(...found) : null;
}

function ewma(previous: number | null, next: number | null | undefined): number | null {
  if (next == null || !Number.isFinite(next) || next <= 0) return previous;
  return previous == null ? next : previous * 0.65 + next * 0.35;
}

function metricsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "")}/metrics`;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException("The operation was aborted", "AbortError");
}

async function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const timer = setTimeout(() => finish(resolve), milliseconds);
    const onAbort = () => finish(() => {
      if (signal?.reason instanceof Error) reject(signal.reason);
      else reject(new DOMException("The operation was aborted", "AbortError"));
    });
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class ModelAdmissionRejectedError extends Error {
  constructor(public readonly decision: AdmissionDecision) {
    super(`model_admission_rejected:${decision.reason}`);
    this.name = "ModelAdmissionRejectedError";
  }
}

export class ModelAdmissionTimeoutError extends Error {
  constructor(public readonly decision: AdmissionDecision) {
    super(`model_admission_timeout:${decision.reason}`);
    this.name = "ModelAdmissionTimeoutError";
  }
}

export class LlamaCppAdmissionController implements AdmissionController {
  private readonly options: ResolvedOptions;
  private readonly llamaMetricsUrl: string;
  private observedTokensPerSecond: number | null = null;
  private observedTtftMs: number | null = null;
  private observedInterTokenLatencyMs: number | null = null;

  constructor(
    baseUrl: string,
    private readonly apiKey: string,
    options: LlamaCppAdmissionOptions = {},
    private readonly fetcher: Fetch = fetch
  ) {
    this.options = {
      contextLimit: positive("contextLimit", options.contextLimit ?? DEFAULTS.contextLimit),
      batchSize: positive("batchSize", options.batchSize ?? DEFAULTS.batchSize),
      maxActiveSequences: positive("maxActiveSequences", options.maxActiveSequences ?? DEFAULTS.maxActiveSequences),
      maxDeferredRequests: positive("maxDeferredRequests", options.maxDeferredRequests ?? DEFAULTS.maxDeferredRequests),
      maxKvCacheUsageRatio: ratio("maxKvCacheUsageRatio", options.maxKvCacheUsageRatio ?? DEFAULTS.maxKvCacheUsageRatio),
      minTokensPerSecond: positive("minTokensPerSecond", options.minTokensPerSecond ?? DEFAULTS.minTokensPerSecond),
      maxTtftMs: positive("maxTtftMs", options.maxTtftMs ?? DEFAULTS.maxTtftMs),
      maxInterTokenLatencyMs: positive("maxInterTokenLatencyMs", options.maxInterTokenLatencyMs ?? DEFAULTS.maxInterTokenLatencyMs),
      maxGpuUtilizationRatio: ratio("maxGpuUtilizationRatio", options.maxGpuUtilizationRatio ?? DEFAULTS.maxGpuUtilizationRatio),
      maxVramUsageRatio: ratio("maxVramUsageRatio", options.maxVramUsageRatio ?? DEFAULTS.maxVramUsageRatio),
      maxContextHighWatermarkRatio: ratio("maxContextHighWatermarkRatio", options.maxContextHighWatermarkRatio ?? DEFAULTS.maxContextHighWatermarkRatio),
      pollIntervalMs: positive("pollIntervalMs", options.pollIntervalMs ?? DEFAULTS.pollIntervalMs),
      maxWaitMs: Math.max(0, options.maxWaitMs ?? DEFAULTS.maxWaitMs),
      telemetryTimeoutMs: positive("telemetryTimeoutMs", options.telemetryTimeoutMs ?? DEFAULTS.telemetryTimeoutMs),
      gpuMetricsUrl: options.gpuMetricsUrl?.trim() || null
    };
    this.llamaMetricsUrl = metricsUrl(baseUrl);
  }

  observeTimings(observation: ModelTimingObservation): void {
    this.observedTokensPerSecond = ewma(this.observedTokensPerSecond, observation.tokensPerSecond);
    this.observedTtftMs = ewma(this.observedTtftMs, observation.ttftMs);
    this.observedInterTokenLatencyMs = ewma(this.observedInterTokenLatencyMs, observation.interTokenLatencyMs);
  }

  async snapshot(requestContextTokens: number, signal?: AbortSignal): Promise<AdmissionSnapshot> {
    throwIfAborted(signal);
    const [llamaText, gpuText] = await Promise.all([
      this.fetchMetrics(this.llamaMetricsUrl, true, signal),
      this.options.gpuMetricsUrl ? this.fetchMetrics(this.options.gpuMetricsUrl, false, signal) : Promise.resolve(null)
    ]);
    const llama = llamaText ? parsePrometheus(llamaText) : new Map<string, number[]>();
    const gpu = gpuText ? parsePrometheus(gpuText) : new Map<string, number[]>();

    const predictedTokens = sum(llama, "llamacpp:tokens_predicted_total");
    const predictedSeconds = sum(llama, "llamacpp:predicted_tokens_seconds", "llamacpp:tokens_predicted_seconds");
    const cumulativeTokensPerSecond = predictedTokens != null && predictedSeconds != null && predictedSeconds > 0
      ? predictedTokens / predictedSeconds
      : null;
    const gpuUtilizationPercent = max(gpu, "DCGM_FI_DEV_GPU_UTIL");
    const framebufferUsed = sum(gpu, "DCGM_FI_DEV_FB_USED");
    const framebufferFree = sum(gpu, "DCGM_FI_DEV_FB_FREE");
    const framebufferTotal = framebufferUsed != null && framebufferFree != null ? framebufferUsed + framebufferFree : null;

    return {
      activeSequences: sum(llama, "llamacpp:requests_processing"),
      queueDepth: sum(llama, "llamacpp:requests_deferred"),
      kvCacheUsageRatio: max(llama, "llamacpp:kv_cache_usage_ratio"),
      tokensPerSecond: this.observedTokensPerSecond ?? cumulativeTokensPerSecond,
      ttftMs: this.observedTtftMs,
      interTokenLatencyMs: this.observedInterTokenLatencyMs,
      gpuUtilizationRatio: gpuUtilizationPercent == null ? null : gpuUtilizationPercent / 100,
      vramUsageRatio: framebufferUsed == null || framebufferTotal == null || framebufferTotal <= 0 ? null : framebufferUsed / framebufferTotal,
      requestContextTokens: Math.max(0, Math.ceil(requestContextTokens)),
      contextHighWatermarkTokens: max(llama, "llamacpp:n_tokens_max"),
      contextLimit: this.options.contextLimit,
      batchSize: this.options.batchSize,
      telemetryAvailable: llamaText != null || gpuText != null
    };
  }

  assess(snapshot: AdmissionSnapshot): AdmissionDecision {
    if (snapshot.requestContextTokens > snapshot.contextLimit) {
      return { action: "reject", reason: "context_limit", snapshot };
    }

    const pressure: string[] = [];
    if (snapshot.activeSequences != null && snapshot.activeSequences >= this.options.maxActiveSequences) pressure.push("active_sequences");
    if (snapshot.queueDepth != null && snapshot.queueDepth >= this.options.maxDeferredRequests) pressure.push("deferred_queue");
    if (snapshot.kvCacheUsageRatio != null && snapshot.kvCacheUsageRatio >= this.options.maxKvCacheUsageRatio) pressure.push("kv_cache");
    if (snapshot.gpuUtilizationRatio != null && snapshot.gpuUtilizationRatio >= this.options.maxGpuUtilizationRatio) pressure.push("gpu_utilization");
    if (snapshot.vramUsageRatio != null && snapshot.vramUsageRatio >= this.options.maxVramUsageRatio) pressure.push("vram");
    if (
      snapshot.contextHighWatermarkTokens != null &&
      snapshot.activeSequences != null && snapshot.activeSequences > 0 &&
      snapshot.contextHighWatermarkTokens / snapshot.contextLimit >= this.options.maxContextHighWatermarkRatio
    ) pressure.push("context_pressure");

    const servingTraffic = (snapshot.activeSequences ?? 0) > 0 || (snapshot.queueDepth ?? 0) > 0;
    if (servingTraffic && snapshot.tokensPerSecond != null && snapshot.tokensPerSecond < this.options.minTokensPerSecond) pressure.push("tokens_per_second");
    if (servingTraffic && snapshot.ttftMs != null && snapshot.ttftMs > this.options.maxTtftMs) pressure.push("ttft");
    if (servingTraffic && snapshot.interTokenLatencyMs != null && snapshot.interTokenLatencyMs > this.options.maxInterTokenLatencyMs) pressure.push("inter_token_latency");

    if (pressure.length) return { action: "defer", reason: pressure.join(","), snapshot };
    return { action: "admit", reason: snapshot.telemetryAvailable ? "capacity_available" : "telemetry_unavailable", snapshot };
  }

  async waitForAdmission(contextTokens: number, signal?: AbortSignal): Promise<AdmissionSnapshot> {
    const started = Date.now();
    let lastDecision: AdmissionDecision | null = null;
    while (true) {
      throwIfAborted(signal);
      const current = await this.snapshot(contextTokens, signal);
      const decision = this.assess(current);
      lastDecision = decision;
      if (decision.action === "admit") return current;
      if (decision.action === "reject") throw new ModelAdmissionRejectedError(decision);
      if (Date.now() - started >= this.options.maxWaitMs) throw new ModelAdmissionTimeoutError(decision);
      await sleep(this.options.pollIntervalMs, signal);
    }
    // Kept for exhaustiveness if the loop structure changes.
    throw new ModelAdmissionTimeoutError(lastDecision as AdmissionDecision);
  }

  private async fetchMetrics(url: string, authenticated: boolean, signal?: AbortSignal): Promise<string | null> {
    try {
      const timeoutSignal = AbortSignal.timeout(this.options.telemetryTimeoutMs);
      const response = await this.fetcher(url, {
        headers: authenticated && this.apiKey ? { authorization: `Bearer ${this.apiKey}`, accept: "text/plain" } : { accept: "text/plain" },
        signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
      });
      if (!response.ok) return null;
      return await response.text();
    } catch (error) {
      throwIfAborted(signal);
      return null;
    }
  }
}
