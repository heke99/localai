#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const baseUrl = (process.env.DIV3RSA_INFERENCE_BASE_URL || process.env.QWEN_INFERENCE_BASE_URL || "").replace(/\/+$/, "");
const apiKey = process.env.DIV3RSA_INFERENCE_API_KEY || process.env.QWEN_INFERENCE_API_KEY || "";
const model = process.env.DIV3RSA_MODEL_RUNTIME_ALIAS || "localai-qwen38-v3-q8";
const outputPath = resolve(root, process.env.DIV3RSA_PROBE_EVIDENCE_OUTPUT || "artifacts/agent-kernel-v2/gpuhub-probe-evidence.json");
const casesPath = resolve(root, process.env.DIV3RSA_PROBE_EVAL_CASES || "evals/agent-kernel-shadow-probe-quality.json");
const concurrency = positiveInteger("DIV3RSA_PROBE_LOAD_CONCURRENCY", 8);
const requestsPerWorker = positiveInteger("DIV3RSA_PROBE_LOAD_REQUESTS_PER_WORKER", 16);
const foregroundMaxTokens = positiveInteger("DIV3RSA_PROBE_LOAD_MAX_TOKENS", 128);
const probeMaxTokens = positiveInteger("DIV3RSA_AGENT_KERNEL_V2_PROBE_MAX_OUTPUT_TOKENS", 128);
const probeTimeoutMs = positiveInteger("DIV3RSA_PROBE_TIMEOUT_MS", 4_000);
const requestTimeoutMs = positiveInteger("DIV3RSA_PROBE_FOREGROUND_TIMEOUT_MS", 120_000);
const sampleBasisPoints = basisPoints("DIV3RSA_PROBE_EVIDENCE_SAMPLE_BPS", 100);

if (!baseUrl || !apiKey) {
  console.error("Missing DIV3RSA_INFERENCE_BASE_URL or DIV3RSA_INFERENCE_API_KEY");
  process.exit(64);
}

function positiveInteger(name, fallback) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`invalid_environment:${name}`);
  return value;
}

function basisPoints(name, fallback) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 10_000) throw new Error(`invalid_environment:${name}`);
  return value;
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function finiteOrThrow(value, name) {
  if (!Number.isFinite(value)) throw new Error(`missing_metric:${name}`);
  return value;
}

function selectedSampleIndexes(total, bps) {
  if (total < 1 || bps < 1) return new Set();
  const target = Math.max(1, Math.round((total * bps) / 10_000));
  const indexes = new Set();
  for (let i = 0; i < target; i += 1) {
    indexes.add(Math.min(total - 1, Math.floor(((i + 0.5) * total) / target)));
  }
  return indexes;
}

function parseJsonObject(content) {
  const trimmed = content.trim();
  const candidates = [trimmed];
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenceMatch?.[1]) candidates.push(fenceMatch[1].trim());
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // Continue through bounded candidates only.
    }
  }
  return null;
}

async function chat({ requestId, messages, maxTokens, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("timeout", "AbortError")), timeoutMs);
  timer.unref?.();
  const started = performance.now();
  let firstTokenAt = null;
  let outputTokens = 0;
  let content = "";
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
        "x-request-id": requestId
      },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0, stream: true, stream_options: { include_usage: true } }),
      signal: controller.signal
    });
    if (!response.ok || !response.body) throw new Error(`HTTP_${response.status}`);
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
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            if (firstTokenAt == null) firstTokenAt = performance.now();
            content += delta;
          }
          if (Number.isFinite(parsed.usage?.completion_tokens)) outputTokens = parsed.usage.completion_tokens;
          if (Number.isFinite(parsed.timings?.predicted_n)) outputTokens = Math.max(outputTokens, parsed.timings.predicted_n);
        }
      }
    }
    if (!outputTokens && content) outputTokens = Math.max(1, Math.round(content.length / 4));
    const ended = performance.now();
    return {
      ok: true,
      content,
      outputTokens,
      ttftMs: firstTokenAt == null ? ended - started : firstTokenAt - started,
      totalMs: ended - started
    };
  } catch (error) {
    return {
      ok: false,
      content: "",
      outputTokens: 0,
      ttftMs: null,
      totalMs: performance.now() - started,
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    clearTimeout(timer);
  }
}

async function runForegroundLoad(label, withProbes) {
  const total = concurrency * requestsPerWorker;
  const sampledIndexes = withProbes ? selectedSampleIndexes(total, sampleBasisPoints) : new Set();
  let next = 0;
  let probeActive = false;
  const foreground = [];
  const probeDurations = [];
  let probeErrors = 0;
  let probeSkipped = 0;
  let probeCalls = 0;
  let probeOutputTokens = 0;
  const probeTasks = [];

  const maybeProbe = (runIndex) => {
    if (!withProbes || !sampledIndexes.has(runIndex)) return;
    if (probeActive) {
      probeSkipped += 1;
      return;
    }
    probeActive = true;
    const task = (async () => {
      const started = performance.now();
      try {
        const result = await chat({
          requestId: `agent-kernel-evidence-probe-${label}-${runIndex}-${crypto.randomUUID()}`,
          maxTokens: probeMaxTokens,
          timeoutMs: probeTimeoutMs,
          messages: [
            { role: "system", content: "You are an independent tool-free shadow verifier. Return exactly one JSON object and nothing else: {\"score\":0-100,\"passed\":boolean,\"reasonCode\":\"short_code\"}. Missing requested proof must fail." },
            { role: "user", content: "Evaluate this intentionally generic baseline answer for completeness: The implementation should validate inputs, handle errors, and include tests." }
          ]
        });
        probeCalls += 1;
        probeDurations.push(performance.now() - started);
        probeOutputTokens += result.outputTokens;
        if (!result.ok) probeErrors += 1;
        else {
          const parsed = parseJsonObject(result.content);
          if (!parsed || typeof parsed.score !== "number" || typeof parsed.passed !== "boolean" || typeof parsed.reasonCode !== "string") probeErrors += 1;
        }
      } finally {
        probeActive = false;
      }
    })();
    probeTasks.push(task);
  };

  const started = performance.now();
  await Promise.all(Array.from({ length: concurrency }, async (_, worker) => {
    while (true) {
      const index = next++;
      if (index >= total) return;
      maybeProbe(index);
      foreground.push(await chat({
        requestId: `agent-kernel-evidence-${label}-${worker}-${index}-${crypto.randomUUID()}`,
        maxTokens: foregroundMaxTokens,
        timeoutMs: requestTimeoutMs,
        messages: [{ role: "user", content: "Implement a TypeScript function that groups records by key, explain complexity briefly, and include one edge-case test." }]
      }));
    }
  }));
  await Promise.all(probeTasks);
  const wallDurationMs = performance.now() - started;
  const successes = foreground.filter((sample) => sample.ok);
  if (successes.length !== foreground.length) throw new Error(`foreground_load_errors:${foreground.length - successes.length}`);
  const decodedTokens = successes.reduce((sum, sample) => sum + sample.outputTokens, 0);
  const sampledRuns = sampledIndexes.size;
  return {
    requests: foreground.length,
    sampleBasisPoints,
    actualSampleRate: total > 0 ? sampledRuns / total : 0,
    p95TtftMs: finiteOrThrow(percentile(successes.map((sample) => sample.ttftMs), 95), `${label}_p95_ttft`),
    aggregateTokensPerSecond: finiteOrThrow(decodedTokens / (wallDurationMs / 1000), `${label}_throughput`),
    wallDurationMs,
    probe: {
      sampledRuns: withProbes ? sampledRuns : 0,
      completedRuns: withProbes ? Math.max(0, sampledRuns - probeSkipped - probeErrors) : 0,
      capacitySkippedRuns: probeSkipped,
      probeErrors,
      totalProbeCalls: probeCalls,
      totalProbeOutputTokens: probeOutputTokens,
      p95ProbeDurationMs: withProbes && probeDurations.length ? finiteOrThrow(percentile(probeDurations, 95), "probe_p95_duration") : 0
    }
  };
}

function parseVerifier(content) {
  const parsed = parseJsonObject(content);
  if (!parsed) return { verifierScore: null, verifierPassed: null, reasonCode: "verifier_output_unparsed" };
  const score = typeof parsed.score === "number" && Number.isFinite(parsed.score) ? Math.max(0, Math.min(100, Math.round(parsed.score))) : null;
  const passed = typeof parsed.passed === "boolean" ? parsed.passed : null;
  const reasonCode = typeof parsed.reasonCode === "string" && /^[a-z0-9_-]{1,80}$/i.test(parsed.reasonCode) ? parsed.reasonCode : "verifier_output_unparsed";
  if (score == null || passed == null || reasonCode === "verifier_output_unparsed") {
    return { verifierScore: null, verifierPassed: null, reasonCode: "verifier_output_unparsed" };
  }
  return { verifierScore: score, verifierPassed: passed, reasonCode };
}

async function runQualityEval() {
  const suite = JSON.parse(await readFile(casesPath, "utf8"));
  if (suite.schemaVersion !== 1 || !Array.isArray(suite.cases) || suite.cases.length < 1) throw new Error("invalid_probe_quality_suite");
  const results = [];
  for (const test of suite.cases) {
    const result = await chat({
      requestId: `agent-kernel-quality-${test.id}-${crypto.randomUUID()}`,
      maxTokens: 96,
      timeoutMs: probeTimeoutMs,
      messages: [
        {
          role: "system",
          content: [
            "You are an independent tool-free quality verifier. Judge only the supplied baseline answer; never infer work that is not explicitly shown.",
            "Return exactly one JSON object and nothing else: {\"score\":0-100,\"passed\":boolean,\"reasonCode\":\"short_machine_code\"}.",
            "passed=true only if every material request requirement and every expectedEvidence item is explicitly satisfied by the baseline answer.",
            "Missing tests, caller impact analysis, rollback/canary controls, tenant isolation, live/current evidence, citations, measurements, authorization boundaries, or other requested proof must fail.",
            "Unsupported claims of safety, correctness, freshness, execution, or completion must fail.",
            "For live/current requests, memory, probability, or an uncited generic value fails even if it might be correct.",
            "Use score >=70 only when passed=true and score <70 when passed=false."
          ].join(" ")
        },
        { role: "user", content: JSON.stringify({ request: test.prompt, baselineAnswer: test.baselineAnswer, expectedEvidence: test.expectedEvidence || [] }) }
      ]
    });
    const parsed = result.ok ? parseVerifier(result.content) : { verifierScore: null, verifierPassed: null, reasonCode: "verifier_request_failed" };
    results.push({ id: test.id, expectedWeakBaseline: Boolean(test.expectedWeakBaseline), ...parsed });
  }
  return results;
}

console.error(`[agent-kernel-evidence] endpoint=${baseUrl} model=${model} concurrency=${concurrency} requestsPerWorker=${requestsPerWorker} sampleBps=${sampleBasisPoints}`);
const health = await fetch(`${baseUrl.replace(/\/v1$/, "")}/health`, { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(2_000) }).catch(() => null);
if (health && !health.ok && health.status !== 404) throw new Error(`model_health_failed:${health.status}`);

console.error("[agent-kernel-evidence] running quality verifier suite");
const qualityCases = await runQualityEval();
console.error("[agent-kernel-evidence] running baseline foreground load");
const baseline = await runForegroundLoad("baseline", false);
console.error("[agent-kernel-evidence] running foreground + sampled bounded probe load");
const loaded = await runForegroundLoad("loaded", true);

const evidence = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  runtime: {
    baseUrl: new URL(baseUrl).origin,
    model,
    concurrency,
    requestsPerWorker,
    foregroundMaxTokens,
    probeMaxTokens,
    probeTimeoutMs,
    sampleBasisPoints,
    actualSampleRate: loaded.actualSampleRate
  },
  cases: qualityCases,
  load: {
    sampledRuns: loaded.probe.sampledRuns,
    completedRuns: loaded.probe.completedRuns,
    capacitySkippedRuns: loaded.probe.capacitySkippedRuns,
    probeErrors: loaded.probe.probeErrors,
    totalProbeCalls: loaded.probe.totalProbeCalls,
    totalProbeOutputTokens: loaded.probe.totalProbeOutputTokens,
    wallDurationMs: loaded.wallDurationMs,
    p95ProbeDurationMs: loaded.probe.p95ProbeDurationMs,
    baselineP95TtftMs: baseline.p95TtftMs,
    loadedP95TtftMs: loaded.p95TtftMs,
    baselineAggregateTokensPerSecond: baseline.aggregateTokensPerSecond,
    loadedAggregateTokensPerSecond: loaded.aggregateTokensPerSecond
  }
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
console.error(`[agent-kernel-evidence] wrote ${outputPath}`);

const gate = spawnSync(process.execPath, ["--experimental-transform-types", "--import", "./infra/runpod/native-typescript-register.mjs", "scripts/eval_agent_kernel_shadow_probes.ts", outputPath], {
  cwd: root,
  stdio: "inherit",
  env: process.env
});
if (gate.error) throw gate.error;
process.exitCode = gate.status ?? 2;
