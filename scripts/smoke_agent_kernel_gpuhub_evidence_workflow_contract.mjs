import { readFile } from "node:fs/promises";

const workflow = await readFile(".github/workflows/agent-kernel-gpuhub-evidence.yml", "utf8");
const request = await readFile("ops/agent-kernel-gpuhub-evidence.request", "utf8");
const runner = await readFile("scripts/eval_agent_kernel_probes_gpuhub.mjs", "utf8");
const preload = await readFile("scripts/agent_kernel_probe_no_thinking_preload.mjs", "utf8");

const required = [
  ['workflows: ["P8 GPUHub Soak"]', "workflow_run must follow P8 GPUHub Soak"],
  ["environment: production-gpuhub", "production-gpuhub environment missing"],
  ["GPUHUB_SSH_KNOWN_HOSTS", "pinned SSH known-hosts missing"],
  ["StrictHostKeyChecking=yes", "strict host checking missing"],
  ["ops/agent-kernel-gpuhub-evidence.request", "explicit request gate missing"],
  ["scripts/eval_agent_kernel_probes_gpuhub.mjs", "evidence runner invocation missing"],
  ["agent_kernel_probe_no_thinking_preload.mjs", "scoped no-thinking preload missing"],
  ["NODE_OPTIONS", "evidence runner must preload scoped verifier transport"],
  ["--parallel[=\\ ]+8", "p8 runtime verification missing"],
  ["--ctx-size[=\\ ]+262144", "p8 context verification missing"],
  ["--spec-type ngram-mod", "speculative profile verification missing"],
  ["DIV3RSA_PROBE_LOAD_REQUESTS_PER_WORKER=16", "evidence load must provide 128 foreground requests"],
  ["DIV3RSA_PROBE_LOAD_MAX_TOKENS=128", "foreground token budget must stay bounded"],
  ["DIV3RSA_AGENT_KERNEL_V2_PROBE_MAX_OUTPUT_TOKENS=128", "configured probe budget must stay bounded before verifier clamp"],
  ["DIV3RSA_PROBE_EVIDENCE_SAMPLE_BPS=100", "evidence must model one-percent sampling"],
  ["DIV3RSA_PROBE_TIMEOUT_MS=4000", "workflow must retain the four-second probe gate"],
  ["unset DIV3RSA_AGENT_KERNEL_V2_PROBES_ENABLED", "production probe enablement must be explicitly absent"],
  ["actions/upload-artifact@v4", "evidence artifact upload missing"],
  ["Enforce promotion gate result", "promotion gate must still be enforced after artifact upload"]
];
for (const [needle, message] of required) if (!workflow.includes(needle)) throw new Error(message);

const runnerRequired = ["selectedSampleIndexes", "sampledRuns: withProbes ? sampledRuns : 0", "actualSampleRate", "every material request requirement", "score <70 when passed=false"];
for (const needle of runnerRequired) if (!runner.includes(needle)) throw new Error(`runner contract missing: ${needle}`);

for (const needle of [
  "agent-kernel-quality-", "agent-kernel-evidence-probe-", 'reasoning_effort: "none"', "enable_thinking: false",
  "VERIFIER_MAX_TOKENS = 64", "LOADED_PROBE_TIMEOUT_MS = 4_000", 'type: "json_schema"', 'name: "shadow_verifier_result"',
  'additionalProperties: false', 'required: ["score", "passed", "reasonCode"]', "max_tokens: Math.min(requestedMax, VERIFIER_MAX_TOKENS)",
  "response_format: VERIFIER_RESPONSE_FORMAT"
]) if (!preload.includes(needle)) throw new Error(`scoped constrained verifier preload missing: ${needle}`);

if (preload.includes("agent-kernel-evidence-baseline-")) throw new Error("baseline foreground benchmark requests must not be intercepted");
for (const needle of ["loadedForegroundIndex", "loadedProbeIndex", "response.clone().arrayBuffer()", "await deferred.promise", "const verifierCall = qualityVerifier || probeIndex != null;", "const signal = probeIndex != null ? AbortSignal.timeout(LOADED_PROBE_TIMEOUT_MS) : init?.signal;"]) {
  if (!preload.includes(needle)) throw new Error(`production-like post-baseline probe timing missing: ${needle}`);
}
for (const needle of [
  "loadedProbePressure", "traceProbeStream", "TransformStream", "validVerifierObject", "verifierContent", "controller.terminate()",
  "phase=before_fetch", "phase=headers", "phase=first_chunk", "phase=json_complete", "phase=stream_end", "phase=fetch_error"
]) {
  if (!preload.includes(needle)) throw new Error(`early verifier completion diagnostic missing: ${needle}`);
}

if (workflow.includes('scp "${ssh_opts[@]}"')) throw new Error("SCP must not reuse SSH -p port options");
if (workflow.indexOf("actions/upload-artifact@v4") > workflow.indexOf("Enforce promotion gate result")) throw new Error("blocked evidence must be uploaded before promotion gate enforcement");
if (workflow.includes('workflows: ["Deploy GPUHub"]')) throw new Error("evidence must not race P8 soak after Deploy GPUHub");

const forbidden = ["rollback-legacy-gpuhub-p1.sh", "recover-legacy-gpuhub", "reconcile-gpuhub-production-profile.sh", "DIV3RSA_FORCE_MODEL_RESTART", "DIV3RSA_AGENT_KERNEL_V2_PROBES_ENABLED=1", "DIV3RSA_AGENT_KERNEL_V2_PROBE_SAMPLE_BPS=", "systemctl restart", "pkill", "killall"];
for (const needle of forbidden) if (workflow.includes(needle)) throw new Error(`observational evidence workflow contains forbidden mutation: ${needle}`);
if (!request.includes("productionSampling=false")) throw new Error("evidence request must explicitly keep production sampling disabled");
console.log("[agent-kernel-gpuhub-evidence-workflow] loaded verifier may end only after schema-valid JSON; four-second gate and production sampling state unchanged");
