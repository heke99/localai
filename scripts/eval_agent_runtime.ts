import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createInferenceAdapter, LlamaCppAdmissionController, modelProtocolProfileFromEnvironment } from "@div3rsa/model-gateway";
import { SkillEngine, type SkillManifest } from "@div3rsa/skill-engine";
import type { ModelAlias } from "@div3rsa/model-sdk";
import { AgentWorkerProcessor, type AgentQueue, type ClaimedRun } from "../services/agent-worker/src/processor";
import { CoreToolRuntime } from "../services/agent-worker/src/core-tool-runtime";
import {
  failedLiveOracleCaseIds,
  resolveLiveEvalOracle,
  validateLiveOracleOutput,
  type LiveEvalOracleKind,
  type LiveEvalOracleResult
} from "../services/agent-worker/src/eval-oracle";

interface EvalCase {
  id: string;
  mode: "chat" | "code" | "lab" | "research";
  prompt: string;
  requiredPatterns?: string[];
  requiredTools?: string[];
  forbiddenTools?: string[];
  requiredSkills?: string[];
  dynamicPattern?: "stockholm-date";
  liveOracle?: LiveEvalOracleKind;
}

interface EvalSuite {
  schemaVersion: number;
  cases: EvalCase[];
}

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

function stockholmDate(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Stockholm",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

class EvalQueue implements AgentQueue {
  private claimed = false;
  readonly startedAt = performance.now();
  firstDeltaAt: number | null = null;
  readonly steps: Array<{ kind: string; status: string; summary: string }> = [];
  skills: string[] = [];
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

  async stream(_runId: string, delta: string, _reset?: boolean): Promise<void> {
    if (delta && this.firstDeltaAt === null) this.firstDeltaAt = performance.now();
  }

  async recordRunIntelligence(_runId: string, _task: unknown, skills: string[]): Promise<void> {
    this.skills = [...skills];
  }

  async recordRepositoryIndex(): Promise<string> { return randomUUID(); }
  async recordImpactAnalysis(): Promise<string> { return randomUUID(); }
  async recordVerificationRun(): Promise<string> { return randomUUID(); }

  async complete(_run: ClaimedRun, output: Completion): Promise<void> {
    this.completion = output;
  }

  async fail(_run: ClaimedRun, errorCode: string, retryable: boolean): Promise<void> {
    this.failure = { code: errorCode, retryable };
  }

  async isCancelled(): Promise<boolean> { return false; }
}

const repositoryRoot = process.env.DIV3RSA_REPOSITORY_ROOT?.trim() || process.cwd();
const suitePath = resolve(repositoryRoot, process.env.DIV3RSA_EVAL_SUITE?.trim() || "evals/agent-runtime-smoke.json");
const suite = JSON.parse(await readFile(suitePath, "utf8")) as EvalSuite;
if (suite.schemaVersion !== 1 || !Array.isArray(suite.cases) || suite.cases.length === 0) throw new Error("invalid_eval_suite");

const modelPort = Math.floor(numericEnvironment("DIV3RSA_MODEL_PORT", 6006));
const modelParallel = Math.max(1, Math.floor(numericEnvironment("DIV3RSA_MODEL_PARALLEL", 1)));
const inferenceBaseUrl = process.env.DIV3RSA_INFERENCE_BASE_URL?.trim()
  || process.env.QWEN_INFERENCE_BASE_URL?.trim()
  || `http://127.0.0.1:${modelPort}/v1`;
const inferenceApiKey = requiredAny(["DIV3RSA_INFERENCE_API_KEY", "QWEN_INFERENCE_API_KEY"]);
const modelProtocolProfile = modelProtocolProfileFromEnvironment();
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
const adapter = createInferenceAdapter({ baseUrl: inferenceBaseUrl, apiKey: inferenceApiKey, profile: modelProtocolProfile, fetcher: fetch, admission });
const health = await adapter.healthCheck();
if (!health.ok) throw new Error(`model_unhealthy:${health.detail ?? "unknown"}`);

const manifest = JSON.parse(await readFile(resolve(repositoryRoot, "skills/runtime-manifest.json"), "utf8")) as SkillManifest;
const skillEngine = new SkillEngine(manifest, { read: (path) => readFile(resolve(repositoryRoot, path), "utf8") });
const coreTools = new CoreToolRuntime({
  searchBaseUrl: process.env.DIV3RSA_SEARCH_BASE_URL?.trim() || null,
  webFetchEnabled: process.env.DIV3RSA_WEB_FETCH_ENABLED?.trim() !== "0",
  maxFetchBytes: numericEnvironment("DIV3RSA_WEB_FETCH_MAX_BYTES", 1_000_000),
  fetchTimeoutMs: numericEnvironment("DIV3RSA_WEB_FETCH_TIMEOUT_MS", 12_000),
  searchTimeoutMs: numericEnvironment("DIV3RSA_WEB_SEARCH_TIMEOUT_MS", 10_000)
});

const results = [] as Array<Record<string, unknown>>;
for (const test of suite.cases) {
  let liveOracle: LiveEvalOracleResult | null = null;
  let liveOracleError: string | null = null;
  if (test.liveOracle) {
    try {
      liveOracle = await resolveLiveEvalOracle(test.liveOracle);
      console.error(`[agent-eval] oracle ${test.id} expected=${liveOracle.expectedValue} source=${liveOracle.sourceUrl}`);
    } catch (error) {
      liveOracleError = error instanceof Error ? error.message : "live_oracle_failed";
      console.error(`[agent-eval] oracle ${test.id} unavailable=${liveOracleError}`);
    }
  }

  const run: ClaimedRun = {
    jobId: `eval-job-${test.id}`,
    runId: randomUUID(),
    mode: test.mode,
    modelAlias: (process.env.DIV3RSA_EVAL_MODEL_ALIAS?.trim() || "general-prod") as ModelAlias,
    prompt: test.prompt,
    requestId: `eval-${test.id}-${randomUUID()}`,
    traceId: randomUUID(),
    resourceContext: []
  };
  const queue = new EvalQueue(run);
  const processor = new AgentWorkerProcessor(queue, { resolve: () => adapter }, `eval-worker-${process.pid}`, {
    prepare: async (mode, prompt) => {
      const loaded = await skillEngine.load(skillEngine.select(mode, prompt));
      return {
        names: loaded.map((skill) => skill.metadata.name),
        instructions: loaded.map((skill) => `## ${skill.metadata.name}@${skill.metadata.version}\n${skill.instructions}`).join("\n\n")
      };
    }
  }, coreTools);

  const started = performance.now();
  await processor.processOnce();
  const ended = performance.now();
  const output = queue.completion?.content ?? "";
  const toolNames = queue.steps.filter((step) => step.kind === "tool").map((step) => step.summary);
  const failures: string[] = [];
  if (!queue.completion) failures.push(`run_not_completed:${queue.failure?.code ?? "unknown"}`);
  if (/<think\b|<\/think>/i.test(output)) failures.push("hidden_reasoning_exposed");
  for (const pattern of test.requiredPatterns ?? []) {
    if (!new RegExp(pattern, "i").test(output)) failures.push(`required_pattern_missing:${pattern}`);
  }
  if (test.dynamicPattern === "stockholm-date" && !output.includes(stockholmDate())) failures.push(`current_stockholm_date_missing:${stockholmDate()}`);
  for (const tool of test.requiredTools ?? []) if (!toolNames.includes(tool)) failures.push(`required_tool_missing:${tool}`);
  for (const tool of test.forbiddenTools ?? []) if (toolNames.includes(tool)) failures.push(`forbidden_tool_used:${tool}`);
  for (const skill of test.requiredSkills ?? []) if (!queue.skills.includes(skill)) failures.push(`required_skill_missing:${skill}`);
  if (test.liveOracle) {
    if (!liveOracle) failures.push(`live_oracle_unavailable:${test.liveOracle}:${liveOracleError ?? "unknown"}`);
    else failures.push(...validateLiveOracleOutput(output, liveOracle));
  }

  const result = {
    id: test.id,
    mode: test.mode,
    passed: failures.length === 0,
    failures,
    latencyMs: Math.round(ended - started),
    answerTtftMs: queue.firstDeltaAt === null ? null : Math.round(queue.firstDeltaAt - queue.startedAt),
    tools: toolNames,
    skills: queue.skills,
    usage: queue.completion?.usage ?? null,
    modelVersionId: queue.completion?.modelVersionId ?? null,
    liveOracle: test.liveOracle
      ? liveOracle
        ? { kind: liveOracle.kind, expectedValue: liveOracle.expectedValue, sourceUrl: liveOracle.sourceUrl, checkedAt: liveOracle.checkedAt }
        : { kind: test.liveOracle, error: liveOracleError ?? "unknown" }
      : null,
    output: output.slice(0, 12_000)
  };
  results.push(result);
  console.error(`[agent-eval] ${result.passed ? "PASS" : "FAIL"} ${test.id} latency=${result.latencyMs}ms tools=${toolNames.join(",") || "none"}`);
}

const passed = results.filter((result) => result.passed === true).length;
const passRate = passed / results.length;
const minimumPassRate = Math.min(1, Math.max(0, numericEnvironment("DIV3RSA_EVAL_MIN_PASS_RATE", 0.85)));
const liveOracleFailures = failedLiveOracleCaseIds(results);
const summary = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  repositoryCommit: process.env.DIV3RSA_EVAL_COMMIT_SHA?.trim() || null,
  inferenceBaseUrl: new URL(inferenceBaseUrl).origin,
  modelParallel,
  modelProtocol: modelProtocolProfile.protocol,
  configuredModelVersionId: modelProtocolProfile.modelVersionId,
  cases: results.length,
  passed,
  failed: results.length - passed,
  passRate,
  minimumPassRate,
  liveOracleFailures,
  allowed: passRate >= minimumPassRate && liveOracleFailures.length === 0,
  results
};

const outputPath = process.env.DIV3RSA_EVAL_OUTPUT?.trim();
if (outputPath) {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
}
console.log(JSON.stringify(summary, null, 2));
if (!summary.allowed) process.exitCode = 2;
