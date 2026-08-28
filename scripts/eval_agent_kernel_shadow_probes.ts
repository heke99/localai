import { readFile } from "node:fs/promises";
import { evaluateShadowProbePromotion, type ShadowProbeEvalCase, type ShadowProbeLoadSample, type ShadowProbePromotionThresholds } from "../services/agent-worker/src/agent-kernel/shadow-probe-eval.ts";

interface InputDocument {
  readonly cases: ShadowProbeEvalCase[];
  readonly load: ShadowProbeLoadSample;
  readonly thresholds?: ShadowProbePromotionThresholds;
}

function usage(): never {
  console.error("usage: npm run eval:agent-kernel-probes -- <input.json>");
  process.exit(2);
}

const inputPath = process.argv[2];
if (!inputPath) usage();

let parsed: InputDocument;
try {
  parsed = JSON.parse(await readFile(inputPath, "utf8")) as InputDocument;
} catch (error) {
  console.error(JSON.stringify({ allowed: false, blockers: ["invalid_eval_input"], detail: error instanceof Error ? error.message : String(error) }));
  process.exit(2);
}

if (!Array.isArray(parsed.cases) || !parsed.load || typeof parsed.load !== "object") {
  console.error(JSON.stringify({ allowed: false, blockers: ["invalid_eval_input_shape"] }));
  process.exit(2);
}

const report = evaluateShadowProbePromotion(parsed.cases, parsed.load, parsed.thresholds);
console.log(JSON.stringify(report, null, 2));
process.exit(report.allowed ? 0 : 1);
