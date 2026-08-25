import { createClient } from "@supabase/supabase-js";
import type { Database } from "@div3rsa/db";
import { LlamaCppAdmissionController, OpenAiCompatibleAdapter } from "@div3rsa/model-gateway";
import { AgentWorkerProcessor } from "./processor";
import { SupabaseAgentQueue } from "./supabase-queue";
import { PermissionedIntegrationToolRuntime } from "./integration-tool-runtime";
import { RemoteProviderToolExecutor } from "./remote-provider-executor";
import { RemoteRepositoryWorkspaceRuntime } from "./repository-runtime";
import { SandboxVerificationRuntime } from "./sandbox-verification";
import { SkillEngine, type SkillManifest } from "@div3rsa/skill-engine";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing_environment:${name}`);
  return value;
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
const inferenceBaseUrl = required("QWEN_INFERENCE_BASE_URL");
const inferenceApiKey = required("QWEN_INFERENCE_API_KEY");
const admission = new LlamaCppAdmissionController(inferenceBaseUrl, inferenceApiKey, {
  contextLimit: numericEnvironment("DIV3RSA_MODEL_CONTEXT_SIZE", 32768),
  batchSize: numericEnvironment("DIV3RSA_MODEL_BATCH_SIZE", 2048),
  maxActiveSequences: numericEnvironment("DIV3RSA_ADMISSION_MAX_ACTIVE_SEQUENCES", 4),
  maxDeferredRequests: numericEnvironment("DIV3RSA_ADMISSION_MAX_DEFERRED_REQUESTS", 4),
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
const repositoryRoot = process.env.DIV3RSA_REPOSITORY_ROOT ?? process.cwd();
const manifest = JSON.parse(await readFile(resolve(repositoryRoot, "skills/runtime-manifest.json"), "utf8")) as SkillManifest;
const skillEngine = new SkillEngine(manifest, { read: (path) => readFile(resolve(repositoryRoot, path), "utf8") });

// The worker never receives provider OAuth tokens. It gets a short-lived one-time execution grant
// and sends only that grant plus tool arguments to the server-side integration gateway.
const gatewayUrl = process.env.DIV3RSA_INTEGRATION_GATEWAY_URL?.trim() || "https://system.div3rsa.com/api/internal/integrations/execute";
const remoteExecutor = new RemoteProviderToolExecutor(gatewayUrl);
const executors = new Map([
  ["github", remoteExecutor],
  ["supabase", remoteExecutor],
  ["vercel", remoteExecutor]
]);
const toolRuntime = new PermissionedIntegrationToolRuntime(supabase as unknown as ConstructorParameters<typeof PermissionedIntegrationToolRuntime>[0], executors);
const repositoryRuntime = new RemoteRepositoryWorkspaceRuntime(supabase as unknown as ConstructorParameters<typeof RemoteRepositoryWorkspaceRuntime>[0], gatewayUrl);
const sandboxRuntime = new SandboxVerificationRuntime(process.env.DIV3RSA_SANDBOX_IMAGE_DIGEST?.trim() || null);
const processor = new AgentWorkerProcessor(queue, { resolve: () => adapter }, workerId, {
  prepare: async (mode, prompt) => {
    const loaded = await skillEngine.load(skillEngine.select(mode, prompt));
    return { names: loaded.map((skill) => skill.metadata.name), instructions: loaded.map((skill) => `## ${skill.metadata.name}@${skill.metadata.version}\n${skill.instructions}`).join("\n\n") };
  }
}, toolRuntime, repositoryRuntime, sandboxRuntime);
let stopping = false;

process.on("SIGTERM", () => { stopping = true; });
process.on("SIGINT", () => { stopping = true; });

async function waitForHealthyModel() {
  const timeoutMs = Math.max(1_000, numericEnvironment("DIV3RSA_MODEL_STARTUP_TIMEOUT_MS", 15 * 60_000));
  const pollMs = Math.max(500, numericEnvironment("DIV3RSA_MODEL_STARTUP_POLL_MS", 5_000));
  const startedAt = Date.now();
  let lastDetail = "not_checked";

  while (!stopping) {
    try {
      const health = await adapter.healthCheck();
      if (health.ok) {
        console.info(`[agent-worker] model ready; worker=${workerId}`);
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

await waitForHealthyModel();

while (!stopping) {
  const processed = await processor.processOnce();
  if (!processed) await sleep(1000);
}
