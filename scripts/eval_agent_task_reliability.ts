import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { ModelAlias } from "@div3rsa/model-sdk";
import { createInferenceAdapter, LlamaCppAdmissionController, modelProtocolProfileFromEnvironment } from "@div3rsa/model-gateway";
import { AgentWorkerProcessor, type AgentQueue, type ClaimedRun } from "../services/agent-worker/src/processor";
import {
  RELIABILITY_CASES,
  ReliabilityFixtureToolRuntime,
  createReliabilityFixtureState,
  verifyReliabilityCase,
  type ReliabilityFixtureSeeds,
  type ReliabilityRunObservation
} from "../services/agent-worker/src/task-reliability-fixture";

interface Completion {
  content: string;
  modelVersionId: string;
  usage: Record<string, number>;
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

function token(prefix: string) {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}

class ReliabilityQueue implements AgentQueue {
  private claimed = false;
  readonly steps: Array<{ kind: string; status: string; summary: string }> = [];
  completion: Completion | null = null;
  failure: { code: string; retryable: boolean } | null = null;

  constructor(private readonly run: ClaimedRun) {}

  async claim(_workerId: string): Promise<ClaimedRun | null> {
    if (this.claimed) return null;
    this.claimed = true;
    return this.run;
  }
  async step(_runId: string, kind: string, status: string, summary: string): Promise<void> {
    this.steps.push({ kind, status, summary });
  }
  async stream(): Promise<void> {}
  async recordRunIntelligence(): Promise<void> {}
  async recordRepositoryIndex(): Promise<string> { return randomUUID(); }
  async recordImpactAnalysis(): Promise<string> { return randomUUID(); }
  async recordVerificationRun(): Promise<string> { return randomUUID(); }
  async complete(_run: ClaimedRun, output: Completion): Promise<void> { this.completion = output; }
  async fail(_run: ClaimedRun, errorCode: string, retryable: boolean): Promise<void> { this.failure = { code: errorCode, retryable }; }
  async isCancelled(): Promise<boolean> { return false; }
}

const modelPort = Math.floor(numericEnvironment("DIV3RSA_MODEL_PORT", 6006));
const modelParallel = Math.max(1, Math.floor(numericEnvironment("DIV3RSA_MODEL_PARALLEL", 1)));
const inferenceBaseUrl = process.env.DIV3RSA_INFERENCE_BASE_URL?.trim()
  || process.env.QWEN_INFERENCE_BASE_URL?.trim()
  || `http://127.0.0.1:${modelPort}/v1`;
const inferenceApiKey = requiredAny(["DIV3RSA_INFERENCE_API_KEY", "QWEN_INFERENCE_API_KEY"]);
const profile = modelProtocolProfileFromEnvironment();
const admission = profile.protocol === "qwen-llamacpp"
  ? new LlamaCppAdmissionController(inferenceBaseUrl, inferenceApiKey, {
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
    })
  : undefined;
const adapter = createInferenceAdapter({ baseUrl: inferenceBaseUrl, apiKey: inferenceApiKey, profile, admission });
const health = await adapter.healthCheck();
if (!health.ok) throw new Error(`model_unhealthy:${health.detail ?? "unknown"}`);

const alias = (process.env.DIV3RSA_TASK_RELIABILITY_MODEL_ALIAS?.trim() || "general-prod") as ModelAlias;
const caseResults: Array<Record<string, unknown>> = [];

for (const definition of RELIABILITY_CASES) {
  const seeds: ReliabilityFixtureSeeds = {
    secretToken: token("RELIABILITY_SECRET"),
    repoToken: token("RELIABILITY_REPO"),
    chainTokens: ["START", token("CHAIN_1"), token("CHAIN_2"), token("CHAIN_3"), token("CHAIN_4"), token("CHAIN_FINAL")]
  };
  const state = createReliabilityFixtureState(seeds);
  const runtime = new ReliabilityFixtureToolRuntime(state);
  const observations: ReliabilityRunObservation[] = [];
  const startedAt = performance.now();

  for (let runNumber = 1; runNumber <= definition.runs; runNumber += 1) {
    const run: ClaimedRun = {
      jobId: `task-reliability-${definition.id}-${runNumber}`,
      runId: randomUUID(),
      mode: "chat",
      modelAlias: alias,
      prompt: definition.prompt,
      requestId: `task-reliability-${definition.id}-${runNumber}-${randomUUID()}`,
      traceId: randomUUID(),
      resourceContext: []
    };
    const queue = new ReliabilityQueue(run);
    const processor = new AgentWorkerProcessor(
      queue,
      { resolve: () => adapter },
      `task-reliability-worker-${process.pid}`,
      { prepare: async () => ({ names: [], instructions: "" }) },
      runtime
    );
    await processor.processOnce();
    observations.push({
      runId: run.runId,
      completed: queue.completion !== null,
      output: queue.completion?.content ?? "",
      modelVersionId: queue.completion?.modelVersionId ?? null,
      failureCode: queue.failure?.code ?? null,
      modelTurns: queue.steps.filter((step) => step.kind === "model" && step.status === "running").length
    });
  }

  const verification = verifyReliabilityCase(definition, state, observations, profile.modelVersionId);
  const result = {
    id: definition.id,
    passed: verification.passed,
    failures: verification.failures,
    latencyMs: Math.round(performance.now() - startedAt),
    runs: observations.length,
    observations: observations.map((observation) => ({
      runId: observation.runId,
      completed: observation.completed,
      modelVersionId: observation.modelVersionId,
      failureCode: observation.failureCode,
      modelTurns: observation.modelTurns,
      output: observation.output.slice(0, 4000)
    })),
    deterministicEvidence: verification.deterministicEvidence
  };
  caseResults.push(result);
  console.error(`[task-reliability] ${result.passed ? "PASS" : "FAIL"} ${definition.id} latency=${result.latencyMs}ms failures=${verification.failures.join(",") || "none"}`);
}

const passed = caseResults.filter((result) => result.passed === true).length;
const summary = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  repositoryCommit: process.env.DIV3RSA_EVAL_COMMIT_SHA?.trim() || null,
  inferenceBaseUrl: new URL(inferenceBaseUrl).origin,
  modelProtocol: profile.protocol,
  configuredModelVersionId: profile.modelVersionId,
  cases: caseResults.length,
  passed,
  failed: caseResults.length - passed,
  passRate: passed / caseResults.length,
  allowed: passed === caseResults.length,
  results: caseResults
};

const outputPath = process.env.DIV3RSA_TASK_RELIABILITY_OUTPUT?.trim();
if (outputPath) {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
}
console.log(JSON.stringify(summary, null, 2));
if (!summary.allowed) process.exitCode = 2;
