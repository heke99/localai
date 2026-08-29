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
  ["agent_kernel_probe_no_thinking_preload.mjs", "scoped verifier preload missing"],
  ["NODE_OPTIONS", "evidence runner must preload scoped verifier transport"],
  ["--parallel[=\\ ]+8", "p8 runtime verification missing"],
  ["--ctx-size[=\\ ]+262144", "p8 context verification missing"],
  ["--spec-type ngram-mod", "speculative profile verification missing"],
  ["DIV3RSA_PROBE_LOAD_CONCURRENCY=7", "evidence must keep seven foreground clients on p8"],
  ["DIV3RSA_PROBE_FOREGROUND_RESERVE_SLOTS=4", "shadow admission must require low-load headroom with at most three active p8 slots"],
  ["DIV3RSA_PROBE_LOAD_REQUESTS_PER_WORKER=286", "evidence must provide roughly twenty samples at one-percent sampling"],
  ["DIV3RSA_PROBE_LOAD_MAX_TOKENS=128", "foreground token budget must stay bounded"],
  ["DIV3RSA_AGENT_KERNEL_V2_PROBE_MAX_OUTPUT_TOKENS=32", "runner request budget must remain bounded before the preload applies the fast-verdict cap"],
  ["DIV3RSA_PROBE_EVIDENCE_SAMPLE_BPS=100", "evidence must model one-percent sampling"],
  ["DIV3RSA_PROBE_RUNTIME_PARALLEL=8", "capacity scheduler must know the p8 runtime width"],
  ["DIV3RSA_PROBE_CAPACITY_WAIT_MS=30000", "shadow capacity queue must have a bounded wait"],
  ["DIV3RSA_PROBE_CAPACITY_POLL_MS=50", "shadow capacity polling must stay bounded"],
  ["DIV3RSA_PROBE_PRIORITY_YIELD_MS=100", "quiet-window foreground priority yield missing"],
  ["DIV3RSA_PROBE_TIMEOUT_MS=4000", "workflow must retain the four-second probe gate"],
  ["unset DIV3RSA_AGENT_KERNEL_V2_PROBES_ENABLED", "production probe enablement must be explicitly absent"],
  ["actions/upload-artifact@v4", "evidence artifact upload missing"],
  ["Enforce promotion gate result", "promotion gate must still be enforced after artifact upload"]
];
for (const [needle, message] of required) if (!workflow.includes(needle)) throw new Error(message);

for (const needle of [
  "selectedSampleIndexes", "readRuntimeCapacity", "/slots", 'llamacpp:requests_processing', 'llamacpp:requests_deferred',
  "foregroundReserveSlots", "minFreeSlotsForShadow", "shadowCapacityAvailable", "state.freeSlots >= minFreeSlotsForShadow",
  "waitForShadowCapacity", "shadowPriorityYieldMs", "reservedForForeground=", "outcome=capacity_skipped", "capacitySkippedRuns",
  "p95CapacityWaitMs", "probeDurations.push(result.totalMs)", "enqueueProbe(index)", "actualSampleRate",
  "every material request requirement", "score <70 when passed=false"
]) if (!runner.includes(needle)) throw new Error(`capacity-aware runner contract missing: ${needle}`);

if (!runner.includes('const concurrency = positiveInteger("DIV3RSA_PROBE_LOAD_CONCURRENCY", 7)')) throw new Error("runner must default to seven foreground clients on p8");
if (!runner.includes('const foregroundReserveSlots = positiveInteger("DIV3RSA_PROBE_FOREGROUND_RESERVE_SLOTS", 1)')) throw new Error("runner must retain a safe default reserve when workflow override is absent");
if (!runner.includes('const minFreeSlotsForShadow = 1 + foregroundReserveSlots')) throw new Error("shadow admission must require its own slot plus the foreground reserve");
if (!runner.includes('const requestsPerWorker = positiveInteger("DIV3RSA_PROBE_LOAD_REQUESTS_PER_WORKER", 286)')) throw new Error("runner must default to statistically meaningful evidence volume");
if (!runner.includes("if (concurrency >= runtimeParallel)")) throw new Error("runner must fail closed without spare runtime capacity");
if (!runner.includes("if (minFreeSlotsForShadow > runtimeParallel)")) throw new Error("runner must fail closed when foreground reserve exceeds runtime width");
if (runner.includes("probeActive")) throw new Error("single active flag must not classify queued shadow work as immediate capacity skip");

for (const needle of [
  "agent-kernel-quality-", "agent-kernel-evidence-probe-", 'reasoning_effort: "none"', "enable_thinking: false",
  "VERIFIER_MAX_TOKENS = 64", "LOADED_PROBE_MAX_TOKENS = 2", "LOADED_PROBE_TIMEOUT_MS = 4_000", 'type: "json_schema"', 'name: "shadow_verifier_result"',
  'additionalProperties: false', 'required: ["score", "passed", "reasonCode"]', "response_format: VERIFIER_RESPONSE_FORMAT",
  "withLoadedFastVerdictConstraints", "canonicalFastVerdict", 'normalized === "W"', 'normalized === "H"',
  "nonStreamingFastVerdictToSse", "loaded_probe_invalid_fast_verdict", "phase=fast_verdict_complete", "transport=nonstream-fast-verdict", "validVerifierObject"
]) if (!preload.includes(needle)) throw new Error(`fast-verdict verifier evidence contract missing: ${needle}`);

if (preload.includes("agent-kernel-evidence-baseline-")) throw new Error("baseline foreground benchmark requests must not be intercepted");
for (const needle of ["loadedForegroundIndex", "loadedProbeIndex", "response.clone().arrayBuffer()", "await deferred.promise", "const verifierCall = qualityVerifier || probeIndex != null;", "const signal = probeIndex != null ? AbortSignal.timeout(LOADED_PROBE_TIMEOUT_MS) : init?.signal;"]) {
  if (!preload.includes(needle)) throw new Error(`production-like post-baseline probe timing missing: ${needle}`);
}
if (workflow.includes('scp "${ssh_opts[@]}"')) throw new Error("SCP must not reuse SSH -p port options");
if (workflow.indexOf("actions/upload-artifact@v4") > workflow.indexOf("Enforce promotion gate result")) throw new Error("blocked evidence must be uploaded before promotion gate enforcement");
if (workflow.includes('workflows: ["Deploy GPUHub"]')) throw new Error("evidence must not race P8 soak after Deploy GPUHub");

const forbidden = ["rollback-legacy-gpuhub-p1.sh", "recover-legacy-gpuhub", "reconcile-gpuhub-production-profile.sh", "DIV3RSA_FORCE_MODEL_RESTART", "DIV3RSA_AGENT_KERNEL_V2_PROBES_ENABLED=1", "DIV3RSA_AGENT_KERNEL_V2_PROBE_SAMPLE_BPS=", "systemctl restart", "pkill", "killall"];
for (const needle of forbidden) if (workflow.includes(needle)) throw new Error(`observational evidence workflow contains forbidden mutation: ${needle}`);
if (!request.includes("productionSampling=false")) throw new Error("evidence request must explicitly keep production sampling disabled");
console.log("[agent-kernel-gpuhub-evidence-workflow] quiet low-load headroom fast-verdict shadow scheduling + statistically meaningful 1% evidence volume present; all promotion gates unchanged");
