import { createClient } from "@supabase/supabase-js";
import type { Database } from "@div3rsa/db";
import { LlamaCppAdmissionController, OpenAiCompatibleAdapter } from "@div3rsa/model-gateway";
import { AgentWorkerProcessor } from "./processor";
import { SupabaseAgentQueue } from "./supabase-queue";
import { PermissionedIntegrationToolRuntime } from "./integration-tool-runtime";
import { CompositeWorkerToolRuntime } from "./composite-tool-runtime";
import { CoreToolRuntime } from "./core-tool-runtime";
import { RemoteProviderToolExecutor } from "./remote-provider-executor";
import { RemoteRepositoryWorkspaceRuntime } from "./repository-runtime";
import { SandboxVerificationRuntime } from "./sandbox-verification";
import { RuntimeRegistration, runtimeRegistrationConfigFromEnvironment, type RuntimeRpcClient } from "./runtime-registration";
import { SkillEngine, type SkillManifest } from "@div3rsa/skill-engine";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing_environment:${name}`);
  return value;
}

function requiredAny(names: string[]): string {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  throw new Error(`missing_environment:${names.join("_or_")}`);
}

function numericEnvironment(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`invalid_environment_number:${name}`);
  return value;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const supabase = createClient<Database>(required("SUPABASE_URL"), required("SUPABASE_SECRET_KEY"), { auth: { persistSession: false, autoRefreshToken: false } });
const modelPort = numericEnvironment("DIV3RSA_MODEL_PORT", 8080);
const modelParallel = Math.max(1, Math.floor(numericEnvironment("DIV3RSA_MODEL_PARALLEL", 4)));
const inferenceBaseUrl = process.env.DIV3RSA_INFERENCE_BASE_URL?.trim()
  || process.env.QWEN_INFERENCE_BASE_URL?.trim()
  || `http://127.0.0.1:${modelPort}/v1`;
const inferenceApiKey = requiredAny(["DIV3RSA_INFERENCE_API_KEY", "QWEN_INFERENCE_API_KEY"]);
const admission = new LlamaCppAdmissionController(inferenceBaseUrl, inferenceApiKey, {
  contextLimit: numericEnvironment("DIV3RSA_MODEL_CONTEXT_SIZE", 32768),
  batchSize: numericEnvironment("DIV3RSA_MODEL_BATCH_SIZE", 2048),
  maxActiveSequences: numericEnvironment("DIV3RSA_ADMISSION_MAX_ACTIVE_SEQUENCES", modelParallel),
  maxDeferredRequests: numericEnvironment("DIV3RSA_ADMISSION_MAX_DEFERRED_REQUESTS", Math.max(2, modelParallel * 2)),
  maxKvCacheUsageRatio: numericEnvironment("DIV3RSA_ADMISSION_MAX_KV_CACHE_RATIO", 0.9),
  minTokensPerSecond: numericEnvironment("DIV3RSA_ADMISSION_MIN_TOKENS_PER_SECOND", 8),
  maxTtftMs: numericEnvironment("DIV3RSA_ADMISSION_MAX_TTFT_MS", 5000),
  maxInterTokenLatencyMs: numericEnvironment("DIV3RSA_ADMISSION_MAX_INTER_TOKEN_MS", 125),
  maxGpuUtilizationRatio: numericEnvironment("DIV3RSA_ADMISSION_MAX_GPU_RATIO", 0.98),
  maxVramUsageRatio: numericEnvironment("DIV3RSA_ADMISSION_MAX_VRAM_RATIO", 0.94),
  maxContextHighWatermarkRatio: numericEnvironment("DIV3RSA_ADMISSION_MAX_CONTEXT_HIGH_WATERMARK_RATIO", 0.95),
  pollIntervalMs: numericEnvironment("DIV3RSA_ADMISSION_POLL_INTERVAL_MS", 250),
  maxWaitMs: numericEnvironment("DIV3RSA_ADMISSION_MAX_WAIT_MS", 30000),
  telemetryTimeoutMs: numericEnvironment("DIV3RSA_ADMISSION_TELEMETRY_TIMEOUT_MS", 1000),
  gpuMetricsUrl: process.env.DIV3RSA_GPU_METRICS_URL?.trim() || null
});
const adapter = new OpenAiCompatibleAdapter(inferenceBaseUrl, inferenceApiKey, fetch, admission);
const queue = new SupabaseAgentQueue(supabase);
const workerId = process.env.DIV3RSA_WORKER_ID ?? `agent-worker-${process.pid}`;
const runtimeConfig = runtimeRegistrationConfigFromEnvironment(modelPort);
const runtimeRegistration = runtimeConfig
  ? new RuntimeRegistration(supabase as unknown as RuntimeRpcClient, runtimeConfig, workerId)
  : null;
const repositoryRoot = process.env.DIV3RSA_REPOSITORY_ROOT ?? process.cwd();
const manifest = JSON.parse(await readFile(resolve(repositoryRoot, "skills/runtime-manifest.json"), "utf8")) as SkillManifest;
const skillEngine = new SkillEngine(manifest, { read: (path) => readFile(resolve(repositoryRoot, path), "utf8") });

// Local deterministic/public-web tools are deliberately separate from account-linked provider tools.
// Provider OAuth credentials never enter this worker; integration writes still require one-time grants.
const coreToolRuntime = new CoreToolRuntime({
  searchBaseUrl: process.env.DIV3RSA_SEARCH_BASE_URL?.trim() || null,
  webFetchEnabled: process.env.DIV3RSA_WEB_FETCH_ENABLED?.trim() !== "0",
  maxFetchBytes: numericEnvironment("DIV3RSA_WEB_FETCH_MAX_BYTES", 1_000_000),
  fetchTimeoutMs: numericEnvironment("DIV3RSA_WEB_FETCH_TIMEOUT_MS", 12_000),
  searchTimeoutMs: numericEnvironment("DIV3RSA_WEB_SEARCH_TIMEOUT_MS", 10_000)
});
const gatewayUrl = process.env.DIV3RSA_INTEGRATION_GATEWAY_URL?.trim() || "https://system.div3rsa.com/api/internal/integrations/execute";
const remoteExecutor = new RemoteProviderToolExecutor(gatewayUrl);
const executors = new Map([
  ["github", remoteExecutor],
  ["supabase", remoteExecutor],
  ["vercel", remoteExecutor]
]);
const integrationToolRuntime = new PermissionedIntegrationToolRuntime(supabase as unknown as ConstructorParameters<typeof PermissionedIntegrationToolRuntime>[0], executors);
const toolRuntime = new CompositeWorkerToolRuntime([coreToolRuntime, integrationToolRuntime]);
const repositoryRuntime = new RemoteRepositoryWorkspaceRuntime(supabase as unknown as ConstructorParameters<typeof RemoteRepositoryWorkspaceRuntime>[0], gatewayUrl);
const sandboxRuntime = new SandboxVerificationRuntime(process.env.DIV3RSA_SANDBOX_IMAGE_DIGEST?.trim() || null);
const processor = new AgentWorkerProcessor(queue, { resolve: () => adapter }, workerId, {
  prepare: async (mode, prompt) => {
    const loaded = await skillEngine.load(skillEngine.select(mode, prompt));
    return { names: loaded.map((skill) => skill.metadata.name), instructions: loaded.map((skill) => `## ${skill.metadata.name}@${skill.metadata.version}\n${skill.instructions}`).join("\n\n") };
  }
}, toolRuntime, repositoryRuntime, sandboxRuntime);
let stopping = false;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

function requestStop() {
  stopping = true;
  if (heartbeatTimer) clearInterval(heartbeatTimer);
}
process.on("SIGTERM", requestStop);
process.on("SIGINT", requestStop);

async function waitForHealthyModel() {
  const timeoutMs = Math.max(1_000, numericEnvironment("DIV3RSA_MODEL_STARTUP_TIMEOUT_MS", 15 * 60_000));
  const pollMs = Math.max(500, numericEnvironment("DIV3RSA_MODEL_STARTUP_POLL_MS", 5_000));
  const startedAt = Date.now();
  let lastDetail = "not_checked";

  while (!stopping) {
    try {
      const health = await adapter.healthCheck();
      if (health.ok) {
        console.info(`[agent-worker] model ready; worker=${workerId}; endpoint=${new URL(inferenceBaseUrl).origin}; parallel=${modelParallel}`);
        return;
      }
      lastDetail = health.detail ?? "unhealthy";
    } catch (error) {
      lastDetail = error instanceof Error ? error.message : "health_check_failed";
    }

    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`model_startup_timeout:${lastDetail}`);
    }

    console.warn(`[agent-worker] waiting for model; worker=${workerId}; detail=${lastDetail}`);
    await sleep(pollMs);
  }
}

async function syncRuntimeRegistration() {
  if (!runtimeRegistration) return;
  try {
    const registered = await runtimeRegistration.sync();
    if (registered) console.info(`[agent-worker] runtime registry ready; worker=${workerId}; provider=${runtimeConfig?.providerKey}`);
  } catch (error) {
    console.warn(`[agent-worker] runtime registry sync failed; worker=${workerId}; detail=${error instanceof Error ? error.message : "runtime_registry_failed"}`);
  }
}

await waitForHealthyModel();
await syncRuntimeRegistration();
if (runtimeRegistration) {
  const heartbeatMs = Math.max(5_000, numericEnvironment("DIV3RSA_RUNTIME_HEARTBEAT_MS", 30_000));
  heartbeatTimer = setInterval(() => { void syncRuntimeRegistration(); }, heartbeatMs);
  heartbeatTimer.unref?.();
}

const idlePollMs = Math.max(100, numericEnvironment("DIV3RSA_QUEUE_IDLE_POLL_MS", 200));
const errorBackoffMs = Math.max(250, numericEnvironment("DIV3RSA_QUEUE_ERROR_BACKOFF_MS", 1000));

while (!stopping) {
  try {
    const processed = await processor.processOnce();
    if (!processed) await sleep(idlePollMs);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "worker_loop_failed";
    console.error(`[agent-worker] processing loop error; worker=${workerId}; detail=${detail}`);
    if (!stopping) await sleep(errorBackoffMs);
  }
}
