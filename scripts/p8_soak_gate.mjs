#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function pushIf(failures, condition, message) {
  if (condition) failures.push(message);
}

export function evaluateP8SoakGate(bundle) {
  const failures = [];
  const evaluations = bundle?.evaluations ?? {};
  for (const name of ["pre", "loaded", "post"]) {
    const result = evaluations[name];
    if (!result || typeof result !== "object") {
      failures.push(`eval_${name}_missing`);
      continue;
    }
    pushIf(failures, result.allowed !== true, `eval_${name}_not_allowed`);
    pushIf(failures, result.modelParallel !== 8, `eval_${name}_wrong_parallel:${String(result.modelParallel)}`);
    const oracleFailures = Array.isArray(result.liveOracleFailures) ? result.liveOracleFailures : [];
    if (oracleFailures.length) failures.push(`eval_${name}_live_oracle_failures:${oracleFailures.join(",")}`);
    pushIf(failures, result.failed !== 0, `eval_${name}_failed_cases:${String(result.failed)}`);
    pushIf(failures, result.cases !== result.passed, `eval_${name}_not_full_pass:${String(result.passed)}/${String(result.cases)}`);
  }

  const thresholds = bundle?.thresholds ?? {};
  const soak = bundle?.soak ?? {};
  const summary = soak?.summary ?? {};
  const minRequests = finite(thresholds.minRequests) ? thresholds.minRequests : 24;
  const maxErrors = finite(thresholds.maxErrors) ? thresholds.maxErrors : 0;
  const maxTtftP95Ms = finite(thresholds.maxTtftP95Ms) ? thresholds.maxTtftP95Ms : 10_000;
  const maxTotalP95Ms = finite(thresholds.maxTotalP95Ms) ? thresholds.maxTotalP95Ms : 20_000;
  const maxVramUsageRatio = finite(thresholds.maxVramUsageRatio) ? thresholds.maxVramUsageRatio : 0.94;

  pushIf(failures, !finite(summary.requests) || summary.requests < minRequests, `soak_insufficient_requests:${String(summary.requests)}`);
  pushIf(failures, !finite(summary.errors) || summary.errors > maxErrors, `soak_errors:${String(summary.errors)}`);
  pushIf(failures, !finite(summary.ttftMs?.p95) || summary.ttftMs.p95 > maxTtftP95Ms, `soak_ttft_p95_exceeded:${String(summary.ttftMs?.p95)}`);
  pushIf(failures, !finite(summary.totalMs?.p95) || summary.totalMs.p95 > maxTotalP95Ms, `soak_total_p95_exceeded:${String(summary.totalMs?.p95)}`);
  pushIf(failures, soak.healthFailures !== 0, `soak_health_failures:${String(soak.healthFailures)}`);
  pushIf(failures, soak.oomIndicators !== 0, `soak_oom_indicators:${String(soak.oomIndicators)}`);

  const vramRatio = bundle?.gpu?.maxVramUsageRatio;
  pushIf(failures, !finite(vramRatio) || vramRatio > maxVramUsageRatio, `gpu_vram_ratio_exceeded:${String(vramRatio)}`);

  const restored = bundle?.restored ?? {};
  pushIf(failures, restored.healthy !== true, "restore_model_unhealthy");
  pushIf(failures, restored.workerHealthy !== true, "restore_worker_unhealthy");
  pushIf(failures, restored.searchHealthy !== true, "restore_search_unhealthy");
  pushIf(failures, restored.parallel !== 1, `restore_wrong_parallel:${String(restored.parallel)}`);
  pushIf(failures, restored.contextSize !== 32768, `restore_wrong_context:${String(restored.contextSize)}`);

  return {
    schemaVersion: 1,
    allowed: failures.length === 0,
    failures,
    thresholds: { minRequests, maxErrors, maxTtftP95Ms, maxTotalP95Ms, maxVramUsageRatio }
  };
}

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error("usage: node scripts/p8_soak_gate.mjs <bundle.json>");
    process.exit(64);
  }
  const bundle = JSON.parse(await readFile(inputPath, "utf8"));
  const result = evaluateP8SoakGate(bundle);
  console.log(JSON.stringify(result, null, 2));
  if (!result.allowed) process.exitCode = 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
