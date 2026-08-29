import { createClient } from "@supabase/supabase-js";
import type { Database } from "@div3rsa/db";
import type { ModelAdapter } from "@div3rsa/model-sdk";
import { LlamaCppAdmissionController, OpenAiCompatibleAdapter } from "@div3rsa/model-gateway";
import { AgentWorkerProcessor } from "./processor";
import { SupabaseAgentQueue } from "./supabase-queue";
import { AgentKernelShadowQueue } from "./agent-kernel/shadow-queue";
import { agentKernelConfigFromEnvironment } from "./agent-kernel/config";
import { AgentKernelShadowProbeRunner } from "./agent-kernel/shadow-probe";
import { shadowProbeConfigFromEnvironment } from "./agent-kernel/shadow-probe-config";
import { AgentKernelActiveCanaryAdapter } from "./agent-kernel/active-canary-adapter";
import { AgentKernelRewindCoordinator, RewindAwareAgentQueue, RewindAwareToolRuntime } from "./agent-kernel/rewind-runtime";
import { PermissionedIntegrationToolRuntime } from "./integration-tool-runtime";
import { CompositeWorkerToolRuntime } from "./composite-tool-runtime";
import { DynamicToolBroker } from "./dynamic-tool-broker";
import { CoreToolRuntime } from "./core-tool-runtime";
import { RemoteProviderToolExecutor } from "./remote-provider-executor";
import { RemoteRepositoryWorkspaceRuntime } from "./repository-runtime";
import { SandboxVerificationRuntime } from "./sandbox-verification";
import { RuntimeRegistration, runtimeRegistrationConfigFromEnvironment, type RuntimeRpcClient } from "./runtime-registration";
import { RuntimeInferenceRouter, type RuntimeInferenceRpcClient } from "./runtime-inference-router";
import { boundedWorkerConcurrency, runWorkerLanes } from "./worker-loop";
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

function booleanEnvironment(name: string, fallback = false): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`invalid_environment_boolean:${name}`);
}

export function inferenceRoutingMode(value = process.env.DIV3RSA_INFERENCE_ROUTING_MODE): "direct" | "registry" {
  const normalized = value?.trim().toLowerCase() || "direct";
  if (normalized === "direct" || normalized === "registry") return normalized;
  throw new Error(`invalid_inference_routing_mode:${value}`);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorDetail(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const value = error as Record<string, unknown>;
    const message = typeof value.message === "string" ? value.message : null;
    const code = typeof value.code === "string" ? value.code : null;
    const details = typeof value.details === "string" ? value.details : null;
    const hint = typeof value.hint === "string" ? value.hint : null;
    const structured = [message, code ? `code=${code}` : null, details ? `details=${details}` : null, hint ? `hint=${hint}` : null].filter(Boolean).join("; ");
    if (structured) return structured.slice(0, 1500);
    try { return JSON.stringify(error).slice(0, 1500); } catch { /* fall through */ }
  }
  return String(error ?? "worker_loop_failed").slice(0, 1500);
}

const supabase = createClient<Database>(required("SUPABASE_URL"), required("SUPABASE_SECRET_KEY"), { auth: { persistSession: false, autoRefreshToken: false } });
const modelPort = numericEnvironment("DIV3RSA_MODEL_PORT", 8080);
const modelParallel = Math.max(1, Math.floor(numericEnvironment("DIV3RSA_MODEL_PARALLEL", 4)));
const workerConcurrency = boundedWorkerConcurrency(numericEnvironment("DIV3RSA_WORKER_CONCURRENCY", modelParallel), modelParallel);
const routingMode = inferenceRoutingMode();
const inferenceBaseUrl = process.env.DIV3RSA_INFERENCE_BASE_URL?.trim()
  || process.env.QWEN_INFERENCE_BASE_URL?.trim()
  || `http://127.0.0.1:${modelPort}/v1`;
const inferenceApiKey = requiredAny(["DIV3RSA_INFERENCE_API_KEY", "QWEN_INFERENCE_API_KEY"]);
const agentKernelConfig = agentKernelConfigFromEnvironment();
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
const directAdapter = new OpenAiCompatibleAdapter(inferenceBaseUrl, inferenceApiKey, fetch, admission);
const inferenceAdapter: ModelAdapter = routingMode === "registry"
  ? new RuntimeInferenceRouter(supabase as unknown as RuntimeInferenceRpcClient, inferenceApiKey)
  : directAdapter;
const adapter: ModelAdapter = new AgentKernelActiveCanaryAdapter(inferenceAdapter, agentKernelConfig);
const baseQueue = new SupabaseAgentQueue(supabase);
const shadowProbeConfig = shadowProbeConfigFromEnvironment();
const shadowProbeRunner = agentKernelConfig.enabled && agentKernelConfig.mode === "shadow"
  ? new AgentKernelShadowProbeRunner(shadowProbeConfig, { generate: (input) => inferenceAdapter.generate({ ...input, disableThinking: true }) })
  : undefined;
const shadowQueue = new AgentKernelShadowQueue(baseQueue, agentKernelConfig, shadowProbeRunner);
const workerId = process.env.DIV3RSA_WORKER_ID ?? `agent-worker-${process.pid}`;
const runtimeConfig = routingMode === "direct" ? runtimeRegistrationConfigFromEnvironment(modelPort) : null;
const runtimeRegistration = runtimeConfig
  ? new RuntimeRegistration(supabase as unknown as RuntimeRpcClient, runtimeConfig, workerId)
  : null;
const repositoryRoot = process.env.DIV3RSA_REPOSITORY_ROOT ?? process.cwd();
const manifest = JSON.parse(await readFile(resolve(repositoryRoot, "skills/runtime-manifest.json"), "utf8")) as SkillManifest;
const skillEngine = new SkillEngine(manifest, { read: (path) => readFile(resolve(repositoryRoot, path), "utf8") });

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
const baseToolRuntime = new CompositeWorkerToolRuntime([coreToolRuntime, integrationToolRuntime]);
const dynamicToolDiscoveryEnabled = booleanEnvironment("DIV3RSA_DYNAMIC_TOOL_DISCOVERY_ENABLED", false);
const discoveredToolRuntime = new DynamicToolBroker(baseToolRuntime, {
  enabled: dynamicToolDiscoveryEnabled,
  maxImmediateTools: Math.max(1, Math.floor(numericEnvironment("DIV3RSA_DYNAMIC_TOOL_MAX_IMMEDIATE", 8))),
  maxDiscoveredToolsPerRun: Math.max(1, Math.floor(numericEnvironment("DIV3RSA_DYNAMIC_TOOL_MAX_DISCOVERED", 16)))
});
const repositoryRuntime = new RemoteRepositoryWorkspaceRuntime(supabase as unknown as ConstructorParameters<typeof RemoteRepositoryWorkspaceRuntime>[0], gatewayUrl);
const checkpointRewindEnabled = booleanEnvironment("DIV3RSA_CHECKPOINT_REWIND_ENABLED", false);
const rewindCoordinator = new AgentKernelRewindCoordinator(repositoryRuntime, discoveredToolRuntime, Math.max(1, Math.floor(numericEnvironment("DIV3RSA_CHECKPOINT_MAX_REWINDS", 2))));
const toolRuntime = new RewindAwareToolRuntime(discoveredToolRuntime, rewindCoordinator, checkpointRewindEnabled);
const queue = new RewindAwareAgentQueue(shadowQueue, rewindCoordinator, checkpointRewindEnabled);
const sandboxRuntime = new SandboxVerificationRuntime(process.env.DIV3RSA_SANDBOX_IMAGE_DIGEST?.trim() || null);
const skillRuntime = {
  prepare: async (mode: Parameters<typeof skillEngine.select>[0], prompt: string) => {
    const loaded = await skillEngine.load(skillEngine.select(mode, prompt));
    return { names: loaded.map((skill) => skill.metadata.name), instructions: loaded.map((skill) => `## ${skill.metadata.name}@${skill.metadata.version}\n${skill.instructions}`).join("\n\n") };
  }
};
const processors = Array.from({ length: workerConcurrency }, (_, lane) => new AgentWorkerProcessor(
  queue,
  { resolve: () => adapter },
  `${workerId}:lane-${lane + 1}`,
  skillRuntime,
  toolRuntime,
  repositoryRuntime,
  sandboxRuntime
));
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
        const endpointDetail = routingMode === "registry" ? (health.detail ?? "registered-route") : new URL(inferenceBaseUrl).origin;
        console.info(`[agent-worker] model ready; worker=${workerId}; routing=${routingMode}; endpoint=${endpointDetail}; parallel=${modelParallel}`);
        return;
      }
      lastDetail = health.detail ?? "unhealthy";
    } catch (error) {
      lastDetail = errorDetail(error);
    }

    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`model_startup_timeout:${lastDetail}`);
    }

    console.warn(`[agent-worker] waiting for model; worker=${workerId}; routing=${routingMode}; detail=${lastDetail}`);
    await sleep(pollMs);
  }
}

async function syncRuntimeRegistration() {
  if (!runtimeRegistration) return;
  try {
    const registered = await runtimeRegistration.sync();
    if (registered) console.info(`[agent-worker] runtime registry ready; worker=${workerId}; provider=${runtimeConfig?.providerKey}`);
  } catch (error) {
    console.warn(`[agent-worker] runtime registry sync failed; worker=${workerId}; detail=${errorDetail(error)}`);
  }
}

await waitForHealthyModel();
await syncRuntimeRegistration();
if (runtimeRegistration) {
  const heartbeatMs = Math.max(5_000, numericEnvironment("DIV3RSA_RUNTIME_HEARTBEAT_MS", 30_000));
  heartbeatTimer = setInterval(() => { void syncRuntimeRegistration(); }, heartbeatMs);
  heartbeatTimer.unref?.();
}

const idlePollMs = Math.max(50, numericEnvironment("DIV3RSA_QUEUE_IDLE_POLL_MS", 100));
const errorBackoffMs = Math.max(250, numericEnvironment("DIV3RSA_QUEUE_ERROR_BACKOFF_MS", 750));
const kernelStatus = agentKernelConfig.enabled
  ? `${agentKernelConfig.mode}${agentKernelConfig.mode === "active" ? `-${agentKernelConfig.activeCanaryBasisPoints}bps` : ""}`
  : "disabled";
console.info(`[agent-worker] processing lanes ready; worker=${workerId}; concurrency=${workerConcurrency}; modelParallel=${modelParallel}; inferenceRouting=${routingMode}; aggregateIdlePollMs=${idlePollMs}; agentKernel=${kernelStatus}; agentKernelShadowProbes=${shadowProbeConfig.enabled ? `sample-${shadowProbeConfig.sampleBasisPoints}bps` : "disabled"}; dynamicToolDiscovery=${dynamicToolDiscoveryEnabled ? "enabled" : "disabled"}; checkpointRewind=${checkpointRewindEnabled ? "enabled" : "disabled"}`);

await runWorkerLanes({
  concurrency: workerConcurrency,
  aggregateIdlePollMs: idlePollMs,
  errorBackoffMs,
  shouldStop: () => stopping,
  processOnce: (lane) => processors[lane]!.processOnce(),
  onError: (error, lane) => {
    const detail = errorDetail(error);
    console.error(`[agent-worker] processing lane error; worker=${workerId}; lane=${lane + 1}; detail=${detail}`);
  }
});
