#!/usr/bin/env node

import { writeFile } from "node:fs/promises";

const baseUrl = (process.env.DIV3RSA_INFERENCE_BASE_URL || process.env.QWEN_INFERENCE_BASE_URL || "http://127.0.0.1:8080/v1").replace(/\/+$/, "");
const apiKey = process.env.DIV3RSA_INFERENCE_API_KEY || process.env.QWEN_INFERENCE_API_KEY || "";
const model = process.env.DIV3RSA_MODEL_RUNTIME_ALIAS || "localai-qwen38-v3-q8";
const maxTokens = positiveInteger("DIV3RSA_BENCH_MAX_TOKENS", 256);
const requestsPerWorker = positiveInteger("DIV3RSA_BENCH_REQUESTS_PER_WORKER", 2);
const timeoutMs = positiveInteger("DIV3RSA_BENCH_TIMEOUT_MS", 120_000);
const warmupRequests = nonNegativeInteger("DIV3RSA_BENCH_WARMUP_REQUESTS", 1);
const matrix = parseMatrix(process.env.DIV3RSA_BENCH_CONCURRENCY || "1,2,4,8");
const prompt = process.env.DIV3RSA_BENCH_PROMPT || "Implement a TypeScript function that groups records by key, explain its complexity briefly, and include one edge-case test.";
const outputPath = process.env.DIV3RSA_BENCH_OUTPUT?.trim() || "";

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

function nonNegativeInteger(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`invalid_environment:${name}`);
  return value;
}

function parseMatrix(raw) {
  const values = [...new Set(raw.split(",").map((part) => Number(part.trim())).filter((value) => Number.isInteger(value) && value > 0))];
  if (!values.length) throw new Error("invalid_concurrency_matrix");
  return values.sort((a, b) => a - b);
}

function percentile(values, percentileValue) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((percentileValue / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, rank))];
}

function rounded(value) {
  return value == null || !Number.isFinite(value) ? null : Math.round(value * 100) / 100;
}

function summarize(samples, wallMs, concurrency) {
  const successes = samples.filter((sample) => sample.ok);
  const ttft = successes.map((sample) => sample.ttftMs).filter(Number.isFinite);
  const total = successes.map((sample) => sample.totalMs).filter(Number.isFinite);
  const decodedTokens = successes.reduce((sum, sample) => sum + (sample.outputTokens || 0), 0);
  const observedRates = successes.map((sample) => sample.modelTokensPerSecond).filter(Number.isFinite);
  return {
    concurrency,
    requests: samples.length,
    successes: successes.length,
    errors: samples.length - successes.length,
    errorRate: rounded(samples.length ? (samples.length - successes.length) / samples.length : 0),
    wallMs: rounded(wallMs),
    ttftMs: { p50: rounded(percentile(ttft, 50)), p95: rounded(percentile(ttft, 95)), p99: rounded(percentile(ttft, 99)) },
    totalMs: { p50: rounded(percentile(total, 50)), p95: rounded(percentile(total, 95)), p99: rounded(percentile(total, 99)) },
    aggregateOutputTokensPerSecond: rounded(wallMs > 0 ? decodedTokens / (wallMs / 1000) : null),
    meanModelTokensPerSecond: rounded(observedRates.length ? observedRates.reduce((sum, value) => sum + value, 0) / observedRates.length : null),
    decodedTokens
  };
}

async function readMetrics() {
  const url = `${baseUrl.replace(/\/v1$/, "")}/metrics`;
  try {
    const response = await fetch(url, { headers: { authorization: `Bearer ${apiKey}`, accept: "text/plain" }, signal: AbortSignal.timeout(2_000) });
    if (!response.ok) return null;
    const text = await response.text();
    const wanted = ["llamacpp:requests_processing", "llamacpp:requests_deferred", "llamacpp:kv_cache_usage_ratio", "llamacpp:n_tokens_max"];
    const metrics = {};
    for (const rawLine of text.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const whitespace = line.search(/\s/);
      if (whitespace < 1) continue;
      const name = line.slice(0, whitespace).replace(/\{.*$/, "");
      if (!wanted.includes(name)) continue;
      const value = Number(line.slice(whitespace).trim().split(/\s+/)[0]);
      if (!Number.isFinite(value)) continue;
      metrics[name] = (metrics[name] || 0) + value;
    }
    return metrics;
  } catch {
    return null;
  }
}

async function oneRequest(label) {
  const started = performance.now();
  let firstTokenAt = null;
  let outputTokens = 0;
  let modelTokensPerSecond = null;
  let contentCharacters = 0;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new DOMException("Benchmark request timeout", "TimeoutError")), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}`, "x-request-id": `bench-${label}-${crypto.randomUUID()}` },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
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
    return { ok: false, ttftMs: null, totalMs: completed - started, outputTokens: 0, modelTokensPerSecond: null, error: error instanceof Error ? error.message : "unknown" };
  } finally {
    clearTimeout(timeout);
  }
}

async function runLevel(concurrency) {
  const totalRequests = concurrency * requestsPerWorker;
  let nextIndex = 0;
  const samples = [];
  const started = performance.now();
  await Promise.all(Array.from({ length: concurrency }, async (_, workerIndex) => {
    while (true) {
      const index = nextIndex++;
      if (index >= totalRequests) return;
      samples.push(await oneRequest(`${concurrency}-${workerIndex}-${index}`));
    }
  }));
  const wallMs = performance.now() - started;
  return { summary: summarize(samples, wallMs, concurrency), samples };
}

console.error(`[capacity-benchmark] endpoint=${baseUrl} model=${model} matrix=${matrix.join(",")} maxTokens=${maxTokens}`);
for (let index = 0; index < warmupRequests; index += 1) await oneRequest(`warmup-${index}`);

const beforeMetrics = await readMetrics();
const levels = [];
for (const concurrency of matrix) {
  console.error(`[capacity-benchmark] running concurrency=${concurrency}`);
  const level = await runLevel(concurrency);
  levels.push(level);
  console.error(`[capacity-benchmark] c=${concurrency} ttft_p95=${level.summary.ttftMs.p95}ms total_p95=${level.summary.totalMs.p95}ms agg=${level.summary.aggregateOutputTokensPerSecond} tok/s errors=${level.summary.errors}`);
}
const afterMetrics = await readMetrics();

const result = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  configuration: { baseUrl, model, matrix, maxTokens, requestsPerWorker, warmupRequests, timeoutMs, promptCharacters: prompt.length },
  metrics: { before: beforeMetrics, after: afterMetrics },
  levels
};

const serialized = `${JSON.stringify(result, null, 2)}\n`;
process.stdout.write(serialized);
if (outputPath) {
  await writeFile(outputPath, serialized, "utf8");
  console.error(`[capacity-benchmark] wrote ${outputPath}`);
}
