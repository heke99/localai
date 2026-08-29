#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const baseUrl = (process.env.DIV3RSA_INFERENCE_BASE_URL || process.env.QWEN_INFERENCE_BASE_URL || "").replace(/\/+$/, "");
const runtimeBaseUrl = baseUrl.replace(/\/v1$/, "");
const apiKey = process.env.DIV3RSA_INFERENCE_API_KEY || process.env.QWEN_INFERENCE_API_KEY || "";
const model = process.env.DIV3RSA_MODEL_RUNTIME_ALIAS || "localai-qwen38-v3-q8";
const outputPath = resolve(root, process.env.DIV3RSA_PROBE_EVIDENCE_OUTPUT || "artifacts/agent-kernel-v2/gpuhub-probe-evidence.json");
const casesPath = resolve(root, process.env.DIV3RSA_PROBE_EVAL_CASES || "evals/agent-kernel-shadow-probe-quality.json");
const concurrency = positiveInteger("DIV3RSA_PROBE_LOAD_CONCURRENCY", 7);
const requestsPerWorker = positiveInteger("DIV3RSA_PROBE_LOAD_REQUESTS_PER_WORKER", 286);
const foregroundMaxTokens = positiveInteger("DIV3RSA_PROBE_LOAD_MAX_TOKENS", 128);
const probeMaxTokens = positiveInteger("DIV3RSA_AGENT_KERNEL_V2_PROBE_MAX_OUTPUT_TOKENS", 32);
const probeTimeoutMs = positiveInteger("DIV3RSA_PROBE_TIMEOUT_MS", 4_000);
const requestTimeoutMs = positiveInteger("DIV3RSA_PROBE_FOREGROUND_TIMEOUT_MS", 120_000);
const sampleBasisPoints = basisPoints("DIV3RSA_PROBE_EVIDENCE_SAMPLE_BPS", 100);
const runtimeParallel = positiveInteger("DIV3RSA_PROBE_RUNTIME_PARALLEL", 8);
const capacityWaitMs = positiveInteger("DIV3RSA_PROBE_CAPACITY_WAIT_MS", 30_000);
const capacityPollMs = positiveInteger("DIV3RSA_PROBE_CAPACITY_POLL_MS", 50);
const shadowPriorityYieldMs = positiveInteger("DIV3RSA_PROBE_PRIORITY_YIELD_MS", 25);

if (!baseUrl || !apiKey) {
  console.error("Missing DIV3RSA_INFERENCE_BASE_URL or DIV3RSA_INFERENCE_API_KEY");
  process.exit(64);
}
if (concurrency >= runtimeParallel) {
  throw new Error(`shadow_evidence_requires_spare_runtime_slot:concurrency=${concurrency}:parallel=${runtimeParallel}`);
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

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
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

function authHeaders(extra = {}) {
  return { authorization: `Bearer ${apiKey}`, ...extra };
}

function slotIsIdle(slot) {
  if (!slot || typeof slot !== "object") return false;
  if (slot.is_processing === false) return true;
  if (slot.processing === false) return true;
  if (slot.state === "idle" || slot.status === "idle") return true;
  if (slot.task_id === -1 && slot.command === "NONE") return true;
  return false;
}

function metricSum(text, name) {
  let total = 0;
  let found = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const space = line.search(/\s/);
    if (space <= 0) continue;
    const metric = line.slice(0, space).replace(/\{.*$/, "");
    if (metric !== name) continue;
    const value = Number(line.slice(space).trim().split(/\s+/)[0]);
    if (!Number.isFinite(value)) continue;
    total += value;
    found = true;
  }
  return found ? total : null;
}

async function readRuntimeCapacity() {
  try {
    const slotsResponse = await fetch(`${runtimeBaseUrl}/slots`, {
      headers: authHeaders({ accept: "application/json" }),
      signal: AbortSignal.timeout(750)
    });
    if (slotsResponse.ok) {
      const payload = await slotsResponse.json();
      const slots = Array.isArray(payload) ? payload : Array.isArray(payload?.slots) ? payload.slots : null;
      if (slots?.length) {
        const freeSlots = slots.filter(slotIsIdle).length;
        const activeSlots = Math.max(0, slots.length - freeSlots);
        return { known: true, source: "slots", totalSlots: slots.length, activeSlots, queueDepth: 0, freeSlots };
      }
    }
  } catch {
    // Fall through to metrics, which is enabled on the production runtime.
  }

  try {
    const metricsResponse = await fetch(`${runtimeBaseUrl}/metrics`, {
      headers: authHeaders({ accept: "text/plain" }),
      signal: AbortSignal.timeout(750)
    });
    if (!metricsResponse.ok) return { known: false, source: "metrics", status: metricsResponse.status };
    const text = await metricsResponse.text();
    const activeSlots = metricSum(text, "llamacpp:requests_processing");
    const queueDepth = metricSum(text, "llamacpp:requests_deferred");
    if (!Number.isFinite(activeSlots) || !Number.isFinite(queueDepth)) return { known: false, source: "metrics" };
    return {
      known: true,
      source: "metrics",
      totalSlots: runtimeParallel,
      activeSlots,
      queueDepth,
      freeSlots: Math.max(0, runtimeParallel - activeSlots)
    };
  } catch (error) {
    return { known: false, source: "metrics", error: error instanceof Error ? error.name : "capacity_read_error" };
  }
}

async function waitForShadowCapacity(requestId) {
  const queuedAt = performance.now();
  const deadline = queuedAt + capacityWaitMs;
  let observations = 0;
  let lastState = null;
  await sleep(shadowPriorityYieldMs);
  while (performance.now() < deadline) {
    const state = await readRuntimeCapacity();
    observations += 1;
    lastState = state;
    if (state.known && state.queueDepth === 0 && state.freeSlots >= 1) {
      await sleep(shadowPriorityYieldMs);
      const confirmed = await readRuntimeCapacity();
      observations += 1;
      lastState = confirmed;
      if (confirmed.known && confirmed.queueDepth === 0 && confirmed.freeSlots >= 1) {
        const waitedMs = performance.now() - queuedAt;
        console.error(`[agent-kernel-capacity] outcome=dispatch requestId=${requestId} waitedMs=${Math.round(waitedMs)} source=${confirmed.source} active=${confirmed.activeSlots} free=${confirmed.freeSlots} deferred=${confirmed.queueDepth}`);
        return { allowed: true, waitedMs, observations, state: confirmed };
      }
    }
    await sleep(capacityPollMs);
  }

  const waitedMs = performance.now() - queuedAt;
  console.error(`[agent-kernel-capacity] outcome=capacity_skipped requestId=${requestId} waitedMs=${Math.round(waitedMs)} observations=${observations} state=${JSON.stringify(lastState)}`);
  return { allowed: false, waitedMs, observations, state: lastState };
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
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}`, "x-request-id": requestId },
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
    return { ok: true, content, outputTokens, ttftMs: firstTokenAt == null ? ended - started : firstTokenAt - started, totalMs: ended - started };
  } catch (error) {
    return { ok: false, content: "", outputTokens: 0, ttftMs: null, totalMs: performance.now() - started, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

async function runForegroundLoad(label, withProbes) {
  const total = concurrency * requestsPerWorker;
  const sampledIndexes = withProbes ? selectedSampleIndexes(total, sampleBasisPoints) : new Set();
  let next = 0;
  const foreground = [];
  const probeDurations = [];
  const capacityWaitDurations = [];
  let probeErrors = 0;
  let probeSkipped = 0;
  let probeCalls = 0;
  let probeOutputTokens = 0;
  const probeTasks = [];
  let shadowTail = Promise.resolve();

  const enqueueProbe = (runIndex) => {
    if (!withProbes || !sampledIndexes.has(runIndex)) return;
    const requestId = `agent-kernel-evidence-probe-${label}-${runIndex}-${crypto.randomUUID()}`;
    const task = shadowTail.then(async () => {
      const capacity = await waitForShadowCapacity(requestId);
      capacityWaitDurations.push(capacity.waitedMs);
      if (!capacity.allowed) {
        probeSkipped += 1;
        return;
      }

      const result = await chat({
        requestId,
        maxTokens: probeMaxTokens,
        timeoutMs: probeTimeoutMs,
        messages: [
          { role: "system", content: "You are an independent tool-free shadow verifier. Return exactly one JSON object and nothing else: {\"score\":0-100,\"passed\":boolean,\"reasonCode\":\"short_code\"}. Missing requested proof must fail." },
          { role: "user", content: "Evaluate this intentionally generic baseline answer for completeness: The implementation should validate inputs, handle errors, and include tests." }
        ]
      });
      probeCalls += 1;
      probeDurations.push(result.totalMs);
      probeOutputTokens += result.outputTokens;
      if (!result.ok) probeErrors += 1;
      else {
        const parsed = parseJsonObject(result.content);
        if (!parsed || typeof parsed.score !== "number" || typeof parsed.passed !== "boolean" || typeof parsed.reasonCode !== "string") probeErrors += 1;
      }
    });
    shadowTail = task.catch(() => undefined);
    probeTasks.push(task);
  };

  const foregroundStarted = performance.now();
  await Promise.all(Array.from({ length: concurrency }, async (_, worker) => {
    while (true) {
      const index = next++;
      if (index >= total) return;
      const result = await chat({
        requestId: `agent-kernel-evidence-${label}-${worker}-${index}-${crypto.randomUUID()}`,
        maxTokens: foregroundMaxTokens,
        timeoutMs: requestTimeoutMs,
        messages: [{ role: "user", content: "Implement a TypeScript function that groups records by key, explain complexity briefly, and include one edge-case test." }]
      });
      foreground.push(result);
      enqueueProbe(index);
    }
  }));
  const foregroundWallDurationMs = performance.now() - foregroundStarted;
  await Promise.all(probeTasks);
  const evidenceWallDurationMs = performance.now() - foregroundStarted;
  const successes = foreground.filter((sample) => sample.ok);
  if (successes.length !== foreground.length) throw new Error(`foreground_load_errors:${foreground.length - successes.length}`);
  const decodedTokens = successes.reduce((sum, sample) => sum + sample.outputTokens, 0);
  const sampledRuns = sampledIndexes.size;
  return {
    requests: foreground.length,
    sampleBasisPoints,
    actualSampleRate: total > 0 ? sampledRuns / total : 0,
    p95TtftMs: finiteOrThrow(percentile(successes.map((sample) => sample.ttftMs), 95), `${label}_p95_ttft`),
    aggregateTokensPerSecond: finiteOrThrow(decodedTokens / (foregroundWallDurationMs / 1000), `${label}_throughput`),
    foregroundWallDurationMs,
    evidenceWallDurationMs,
    probe: {
      sampledRuns: withProbes ? sampledRuns : 0,
      completedRuns: withProbes ? Math.max(0, sampledRuns - probeSkipped - probeErrors) : 0,
      capacitySkippedRuns: probeSkipped,
      probeErrors,
      totalProbeCalls: probeCalls,
      totalProbeOutputTokens: probeOutputTokens,
      p95ProbeDurationMs: withProbes && probeDurations.length ? finiteOrThrow(percentile(probeDurations, 95), "probe_p95_duration") : 0,
      p95CapacityWaitMs: withProbes && capacityWaitDurations.length ? finiteOrThrow(percentile(capacityWaitDurations, 95), "capacity_wait_p95") : 0
    }
  };
}

function parseVerifier(content) {
  const parsed = parseJsonObject(content);
  if (!parsed) return { verifierScore: null, verifierPassed: null, reasonCode: "verifier_output_unparsed" };
  const score = typeof parsed.score === "number" && Number.isFinite(parsed.score) ? Math.max(0, Math.min(100, Math.round(parsed.score))) : null;
  const passed = typeof parsed.passed === "boolean" ? parsed.passed : null;
  const reasonCode = typeof parsed.reasonCode === "string" && /^[a-z0-9_-]{1,80}$/i.test(parsed.reasonCode) ? parsed.reasonCode : "verifier_output_unparsed";
  if (score == null || passed == null || reasonCode === "verifier_output_unparsed") return { verifierScore: null, verifierPassed: null, reasonCode: "verifier_output_unparsed" };
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

console.error(`[agent-kernel-evidence] endpoint=${baseUrl} model=${model} concurrency=${concurrency} runtimeParallel=${runtimeParallel} requestsPerWorker=${requestsPerWorker} sampleBps=${sampleBasisPoints}`);
const health = await fetch(`${runtimeBaseUrl}/health`, { headers: authHeaders(), signal: AbortSignal.timeout(2_000) }).catch(() => null);
if (health && !health.ok && health.status !== 404) throw new Error(`model_health_failed:${health.status}`);

console.error("[agent-kernel-evidence] running quality verifier suite");
const qualityCases = await runQualityEval();
console.error("[agent-kernel-evidence] running baseline foreground load");
const baseline = await runForegroundLoad("baseline", false);
console.error("[agent-kernel-evidence] running foreground + capacity-aware sampled shadow load");
const loaded = await runForegroundLoad("loaded", true);

const evidence = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  runtime: {
    baseUrl: new URL(baseUrl).origin,
    model,
    concurrency,
    runtimeParallel,
    requestsPerWorker,
    foregroundMaxTokens,
    probeMaxTokens,
    probeTimeoutMs,
    capacityWaitMs,
    capacityPollMs,
    shadowPriorityYieldMs,
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
    wallDurationMs: loaded.foregroundWallDurationMs,
    evidenceWallDurationMs: loaded.evidenceWallDurationMs,
    p95CapacityWaitMs: loaded.probe.p95CapacityWaitMs,
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
