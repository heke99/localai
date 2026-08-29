import { readFile, writeFile } from "node:fs/promises";
import { evaluateOptimizationCandidate, type OptimizationCandidate, type OptimizationEvalSnapshot } from "../services/agent-worker/src/agent-kernel/optimizer";
import type { VerifiedLearningDatasetManifest } from "../services/agent-worker/src/agent-kernel/learning-export";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing_environment:${name}`);
  return value;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

const dataset = await readJson<VerifiedLearningDatasetManifest>(required("DIV3RSA_LEARNING_DATASET"));
const baseline = await readJson<OptimizationEvalSnapshot>(required("DIV3RSA_OPTIMIZER_BASELINE_EVAL"));
const candidate = await readJson<OptimizationEvalSnapshot>(required("DIV3RSA_OPTIMIZER_CANDIDATE_EVAL"));
const definition = await readJson<OptimizationCandidate>(required("DIV3RSA_OPTIMIZER_CANDIDATE_DEFINITION"));
const output = process.env.DIV3RSA_OPTIMIZER_OUTPUT?.trim() || "agent-optimization-decision.json";

const decision = evaluateOptimizationCandidate({ dataset, baseline, candidate, definition });
await writeFile(output, `${JSON.stringify(decision, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
console.info(JSON.stringify({
  allowed: decision.allowed,
  reasons: decision.reasons,
  datasetDigest: decision.datasetDigest,
  evalSetDigest: decision.evalSetDigest,
  decisionDigest: decision.decisionDigest,
  output
}));

if (!decision.allowed) process.exitCode = 2;
