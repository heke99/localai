import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { LlamaCppAdmissionController, OpenAiCompatibleAdapter } from "@div3rsa/model-gateway";
import type { ModelAlias, ModelToolCall, ModelToolDefinition } from "@div3rsa/model-sdk";
import { AgentWorkerProcessor, type AgentQueue, type ClaimedRun, type WorkerToolRuntime } from "../services/agent-worker/src/processor";
import { HttpSecurityToolExecutor, SecurityToolRuntime } from "../services/agent-worker/src/security-tool-runtime";

interface Completion { content: string; modelVersionId: string; usage: Record<string, number>; }
interface SecurityExecution { call: ModelToolCall; output: Record<string, unknown>; }
interface SecurityAttempt { call: ModelToolCall; error?: string; }

class EvalQueue implements AgentQueue {
  private claimed = false;
  completion: Completion | null = null;
  failure: { code: string; retryable: boolean } | null = null;
  readonly steps: Array<{ kind: string; status: string; summary: string }> = [];
  constructor(private readonly run: ClaimedRun) {}
  async claim(): Promise<ClaimedRun | null> { if (this.claimed) return null; this.claimed = true; return this.run; }
  async step(_runId: string, kind: string, status: string, summary: string): Promise<void> { this.steps.push({ kind, status, summary }); }
  async stream(): Promise<void> {}
  async recordRunIntelligence(): Promise<void> {}
  async recordRepositoryIndex(): Promise<string> { return randomUUID(); }
  async recordImpactAnalysis(): Promise<string> { return randomUUID(); }
  async recordVerificationRun(): Promise<string> { return randomUUID(); }
  async complete(_run: ClaimedRun, output: Completion): Promise<void> { this.completion = output; }
  async fail(_run: ClaimedRun, errorCode: string, retryable: boolean): Promise<void> { this.failure = { code: errorCode, retryable }; }
  async isCancelled(): Promise<boolean> { return false; }
}

class ExactReadinessSecurityRuntime implements WorkerToolRuntime {
  readonly executions: SecurityExecution[] = [];
  readonly attempts: SecurityAttempt[] = [];
  constructor(
    private readonly inner: SecurityToolRuntime,
    private readonly expectedTool: string,
    private readonly expectedTarget: string
  ) {}

  async list(run: ClaimedRun): Promise<ModelToolDefinition[]> {
    const definitions = await this.inner.list(run);
    return definitions.map((definition) => {
      if (definition.name !== "security_scan") return definition;
      const schema = structuredClone(definition.inputSchema) as Record<string, unknown>;
      const properties = schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
        ? schema.properties as Record<string, unknown>
        : {};
      properties.tool = {
        type: "string",
        enum: [this.expectedTool],
        description: `Production-readiness operation. The only valid value is ${this.expectedTool}.`
      };
      properties.target = {
        type: "string",
        enum: [this.expectedTarget],
        description: `Production-readiness target. The only valid value is ${this.expectedTarget}.`
      };
      schema.properties = properties;
      return { ...definition, inputSchema: schema };
    });
  }

  async execute(run: ClaimedRun, call: ModelToolCall): Promise<unknown> {
    const attempt: SecurityAttempt = { call };
    this.attempts.push(attempt);
    try {
      if (call.name !== "security_scan") throw new Error(`readiness_unexpected_tool_name:${call.name}`);
      if (call.input.tool !== this.expectedTool) throw new Error(`readiness_unexpected_tool_id:${String(call.input.tool)}`);
      if (call.input.target !== this.expectedTarget) throw new Error(`readiness_unexpected_target:${String(call.input.target)}`);
      const output = await this.inner.execute(run, call) as Record<string, unknown>;
      this.executions.push({ call, output });
      return output;
    } catch (error) {
      attempt.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }
}

function requiredAny(names: string[]): string {
  for (const name of names) { const value = process.env[name]?.trim(); if (value) return value; }
  throw new Error(`missing_environment:${names.join("_or_")}`);
}
function numericEnvironment(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`invalid_environment_number:${name}`);
  return value;
}

const modelPort = Math.floor(numericEnvironment("DIV3RSA_MODEL_PORT", 6006));
const inferenceBaseUrl = process.env.DIV3RSA_INFERENCE_BASE_URL?.trim() || process.env.QWEN_INFERENCE_BASE_URL?.trim() || `http://127.0.0.1:${modelPort}/v1`;
const inferenceApiKey = requiredAny(["DIV3RSA_INFERENCE_API_KEY", "QWEN_INFERENCE_API_KEY"]);
const executorBaseUrl = process.env.DIV3RSA_SECURITY_EXECUTOR_URL?.trim() || "http://127.0.0.1:7319";
const executorToken = requiredAny(["DIV3RSA_SECURITY_EXECUTOR_TOKEN"]);
const readinessProof = requiredAny(["DIV3RSA_SECURITY_READINESS_TOKEN"]);
const targetIp = process.env.DIV3RSA_SECURITY_E2E_IP?.trim() || "127.0.0.1";
const httpPort = Math.floor(numericEnvironment("DIV3RSA_SECURITY_E2E_PORT", 18080));
const tlsPort = Math.floor(numericEnvironment("DIV3RSA_SECURITY_E2E_TLS_PORT", 18443));
const auditLogPath = process.env.DIV3RSA_SECURITY_AUDIT_LOG?.trim() || "/var/log/div3rsa/security-executor.jsonl";

const admission = new LlamaCppAdmissionController(inferenceBaseUrl, inferenceApiKey, {
  contextLimit: numericEnvironment("DIV3RSA_MODEL_CONTEXT_SIZE", 32768), batchSize: numericEnvironment("DIV3RSA_MODEL_BATCH_SIZE", 2048), maxActiveSequences: 1, maxDeferredRequests: 2,
  maxKvCacheUsageRatio: 0.9, minTokensPerSecond: 4, maxTtftMs: 10_000, maxInterTokenLatencyMs: 250, maxGpuUtilizationRatio: 0.99, maxVramUsageRatio: 0.97,
  maxContextHighWatermarkRatio: 0.97, pollIntervalMs: 250, maxWaitMs: 45_000, telemetryTimeoutMs: 1_000, gpuMetricsUrl: process.env.DIV3RSA_GPU_METRICS_URL?.trim() || null
});
const adapter = new OpenAiCompatibleAdapter(inferenceBaseUrl, inferenceApiKey, fetch, admission);
const health = await adapter.healthCheck();
if (!health.ok) throw new Error(`model_unhealthy:${health.detail ?? "unknown"}`);

const cases = [
  { tool: "dns_lookup", target: targetIp, options: {} },
  { tool: "http_probe", target: `http://${targetIp}:${httpPort}/`, options: {} },
  { tool: "tls_probe", target: `https://${targetIp}:${tlsPort}/`, options: {} },
  { tool: "port_scan", target: targetIp, options: { ports: [httpPort, tlsPort], maxRate: 20 } },
  { tool: "template_scan", target: `http://${targetIp}:${httpPort}/`, options: { rateLimit: 5 } },
  { tool: "content_discovery", target: `http://${targetIp}:${httpPort}/`, options: { rateLimit: 5 } }
] as const;

const expectedAuditIds = new Map<string, string>();
const results: Array<Record<string, unknown>> = [];
for (const test of cases) {
  const run: ClaimedRun = {
    jobId: `security-readiness-${test.tool}`, runId: randomUUID(), mode: "lab", modelAlias: (process.env.DIV3RSA_EVAL_MODEL_ALIAS?.trim() || "general-prod") as ModelAlias,
    prompt: `Authorized production-readiness check. Use security_scan exactly once. The tool schema permits exactly one operation and one target. Use the supplied options exactly: ${JSON.stringify(test.options)}. After the tool result, answer only SECURITY_RUNTIME_READY ${test.tool}.`,
    requestId: `security-readiness-${test.tool}-${randomUUID()}`, traceId: randomUUID(),
    resourceContext: [{ resourceId: "security-readiness-scope", connectionId: "security-readiness-local", provider: "local", resourceType: "security_scope", externalResourceId: "security-readiness-owned-target", displayName: "Owned ephemeral GPUHub readiness target", capabilities: ["security.active"], metadata: { allowHosts: [], allowIpv4Cidrs: [`${targetIp}/32`], readinessProof } }]
  };
  const queue = new EvalQueue(run);
  const security = new ExactReadinessSecurityRuntime(
    new SecurityToolRuntime(new HttpSecurityToolExecutor(`${executorBaseUrl}/v1/execute`, executorToken)),
    test.tool,
    test.target
  );
  const processor = new AgentWorkerProcessor(
    queue, { resolve: () => adapter }, `security-readiness-worker-${process.pid}`,
    { prepare: async () => ({ names: [], instructions: `SECURITY READINESS REQUIRED: the first model turn MUST call security_scan exactly once. Its JSON schema has already been narrowed to the exact production-readiness operation and target. This marker is reserved for the production readiness harness.` }) },
    security
  );
  const started = performance.now();
  await processor.processOnce();
  const execution = security.executions.find((entry) => entry.call.input.tool === test.tool && entry.call.input.target === test.target);
  const failures: string[] = [];
  if (!queue.completion) failures.push(`run_not_completed:${queue.failure?.code ?? "unknown"}`);
  if (!execution) failures.push(`security_operation_not_executed:${test.tool}`);
  const output = execution?.output ?? {};
  if (output.ok !== true) failures.push(`security_operation_not_ok:${test.tool}:exit=${String(output.exitCode ?? "unknown")}`);
  if (typeof output.auditId !== "string" || !output.auditId) failures.push(`audit_id_missing:${test.tool}`);
  if (typeof output.capability !== "string" || !output.capability) failures.push(`capability_missing:${test.tool}`);
  if (test.tool === "template_scan" && (!Array.isArray(output.findings) || output.findings.length < 1)) failures.push("template_readiness_match_missing");
  if (test.tool === "content_discovery" && (!Array.isArray(output.findings) || output.findings.length < 1)) failures.push("content_discovery_match_missing");
  if (typeof output.auditId === "string" && output.auditId) expectedAuditIds.set(output.auditId, test.tool);
  results.push({
    tool: test.tool,
    target: test.target,
    passed: failures.length === 0,
    failures,
    latencyMs: Math.round(performance.now() - started),
    auditId: output.auditId ?? null,
    capability: output.capability ?? null,
    attempts: security.attempts.map((attempt) => ({ name: attempt.call.name, input: attempt.call.input, error: attempt.error ?? null })),
    queueFailure: queue.failure,
    completion: queue.completion ? { content: queue.completion.content.slice(0, 160), modelVersionId: queue.completion.modelVersionId } : null
  });
}

const auditText = await readFile(auditLogPath, "utf8");
const auditRows = auditText.split(/\r?\n/).filter(Boolean).flatMap((line) => { try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; } });
for (const [auditId, tool] of expectedAuditIds) {
  const row = auditRows.find((candidate) => candidate.auditId === auditId);
  const result = results.find((candidate) => candidate.tool === tool)!;
  const failures = result.failures as string[];
  if (!row) failures.push(`audit_row_missing:${tool}`);
  else {
    if (row.status !== "completed") failures.push(`audit_status_not_completed:${tool}:${String(row.status)}`);
    if (row.tool !== tool) failures.push(`audit_tool_mismatch:${tool}`);
    if (row.scopeId !== "security-readiness-scope") failures.push(`audit_scope_mismatch:${tool}`);
  }
  result.passed = failures.length === 0;
}
const passed = results.filter((result) => result.passed === true).length;
const summary = { schemaVersion: 1, generatedAt: new Date().toISOString(), cases: results.length, passed, failed: results.length - passed, allowed: passed === results.length, results };
console.log(JSON.stringify(summary, null, 2));
if (!summary.allowed) process.exitCode = 2;
