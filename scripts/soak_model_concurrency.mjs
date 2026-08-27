#!/usr/bin/env node

import { writeFile } from "node:fs/promises";

const baseUrl = (process.env.DIV3RSA_INFERENCE_BASE_URL || process.env.QWEN_INFERENCE_BASE_URL || "http://127.0.0.1:6006/v1").replace(/\/+$/, "");
const apiKey = process.env.DIV3RSA_INFERENCE_API_KEY || process.env.QWEN_INFERENCE_API_KEY || "";
const model = process.env.DIV3RSA_MODEL_RUNTIME_ALIAS || "localai-qwen38-v3-q8";
const durationSeconds = positiveInteger("DIV3RSA_SOAK_DURATION_SECONDS", 300);
const concurrency = positiveInteger("DIV3RSA_SOAK_CONCURRENCY", 6);
const maxTokens = positiveInteger("DIV3RSA_SOAK_MAX_TOKENS", 192);
const timeoutMs = positiveInteger("DIV3RSA_SOAK_TIMEOUT_MS", 120_000);
const healthIntervalMs = positiveInteger("DIV3RSA_SOAK_HEALTH_INTERVAL_MS", 2_000);
const outputPath = process.env.DIV3RSA_SOAK_OUTPUT?.trim() || "";
const origin = baseUrl.replace(/\/v1$/, "");

if (!apiKey) {
  console.error("Missing DIV3RSA_INFERENCE_API_KEY (legacy QWEN_INFERENCE_API_KEY is also accepted).");
  process.exit(64);
}

function positiveInteger(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`invalid_environment:${name}`);
  return value;
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1))];
}

function rounded(value) {
  return value == null || !Number.isFinite(value) ? null : Math.round(value * 100) / 100;
}

const longContext = Array.from({ length: 140 }, (_, index) =>
  `function handler${index}(input: Record<string, unknown>) { return input["key${index % 12}"] ?? null; }`
).join("\n");

const prompts = [
  "Implement a TypeScript function that groups records by key, explain complexity briefly, and include one edge-case test.",
  "Review this PostgreSQL pattern for a multi-tenant SaaS: SELECT * FROM orders WHERE tenant_id = $1 AND status = $2 ORDER BY created_at DESC LIMIT 100. Suggest safe indexing and explain tradeoffs.",
  "A queue has 8 workers, retryable jobs, and a 25% recovery reserve. Explain how you would prevent overload while preserving interactive latency. Keep the answer concrete.",
  `Find one maintainability or performance problem in this synthetic TypeScript module and propose a minimal correction. Do not rewrite unrelated code.\n\n${longContext}`
];

async function oneRequest(workerIndex, requestIndex) {
  const started = performance.now();
  let firstTokenAt = null;
  let outputTokens = 0;
  let contentCharacters = 0;
  let modelTokensPerSecond = null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("Soak request timeout", "TimeoutError")), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
        "x-request-id": `p8-soak-${workerIndex}-${requestIndex}-${crypto.randomUUID()}`
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompts[(workerIndex + requestIndex) % prompts.length] }],
        max_tokens: maxTokens,
        temperature: 0,
        stream: true,
        stream_options: { include_usage: true }
      }),
      signal: controller.signal
    });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value;
      const events = buffer.split("\n\n");
      buffer = events.pop() || "";
      for (const event of events) {
        for (const line of event.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          const parsed = JSON.parse(data);
          const content = parsed.choices?.[0]?.delta?.content;
          if (content) {
            if (firstTokenAt == null) firstTokenAt = performance.now();
            contentCharacters += content.length;
          }
          if (Number.isFinite(parsed.usage?.completion_tokens)) outputTokens = parsed.usage.completion_tokens;
          if (Number.isFinite(parsed.timings?.predicted_per_second)) modelTokensPerSecond = parsed.timings.predicted_per_second;
          if (Number.isFinite(parsed.timings?.predicted_n)) outputTokens = Math.max(outputTokens, parsed.timings.predicted_n);
        }
      }
    }
    if (!outputTokens && contentCharacters) outputTokens = Math.max(1, Math.round(contentCharacters / 4));
    const completed = performance.now();
    return {
      ok: true,
      ttftMs: firstTokenAt == null ? completed - started : firstTokenAt - started,
      totalMs: completed - started,
      outputTokens,
      modelTokensPerSecond
    };
  } catch (error) {
    const completed = performance.now();
    return {
      ok: false,
      ttftMs: null,
      totalMs: completed - started,
      outputTokens: 0,
      modelTokensPerSecond: null,
      error: error instanceof Error ? error.message : "unknown"
    };
  } finally {
    clearTimeout(timer);
  }
}

const samples = [];
let healthFailures = 0;
let stopHealth = false;
const healthTask = (async () => {
  while (!stopHealth) {
    try {
      const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(2_000) });
      if (!response.ok) healthFailures += 1;
    } catch {
      healthFailures += 1;
    }
    await new Promise((resolve) => setTimeout(resolve, healthIntervalMs));
  }
})();

const startedAt = performance.now();
const deadline = startedAt + durationSeconds * 1000;
await Promise.all(Array.from({ length: concurrency }, async (_, workerIndex) => {
  let requestIndex = 0;
  while (performance.now() < deadline) {
    samples.push(await oneRequest(workerIndex, requestIndex));
    requestIndex += 1;
  }
}));
stopHealth = true;
await healthTask;
const completedAt = performance.now();

const successes = samples.filter((sample) => sample.ok);
const ttft = successes.map((sample) => sample.ttftMs).filter(Number.isFinite);
const total = successes.map((sample) => sample.totalMs).filter(Number.isFinite);
const decodedTokens = successes.reduce((sum, sample) => sum + (sample.outputTokens || 0), 0);
const modelRates = successes.map((sample) => sample.modelTokensPerSecond).filter(Number.isFinite);
const wallMs = completedAt - startedAt;
const result = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  configuration: { baseUrl, model, durationSeconds, concurrency, maxTokens, timeoutMs, promptCount: prompts.length },
  summary: {
    requests: samples.length,
    successes: successes.length,
    errors: samples.length - successes.length,
    errorRate: rounded(samples.length ? (samples.length - successes.length) / samples.length : 0),
    wallMs: rounded(wallMs),
    ttftMs: { p50: rounded(percentile(ttft, 50)), p95: rounded(percentile(ttft, 95)), p99: rounded(percentile(ttft, 99)) },
    totalMs: { p50: rounded(percentile(total, 50)), p95: rounded(percentile(total, 95)), p99: rounded(percentile(total, 99)) },
    aggregateOutputTokensPerSecond: rounded(wallMs > 0 ? decodedTokens / (wallMs / 1000) : null),
    meanModelTokensPerSecond: rounded(modelRates.length ? modelRates.reduce((sum, value) => sum + value, 0) / modelRates.length : null),
    decodedTokens
  },
  healthFailures,
  samples
};

const serialized = `${JSON.stringify(result, null, 2)}\n`;
process.stdout.write(serialized);
if (outputPath) await writeFile(outputPath, serialized, "utf8");
