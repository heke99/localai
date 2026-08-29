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
  ["DIV3RSA_AGENT_KERNEL_V2_PROBE_MAX_OUTPUT_TOKENS=128", "probe token budget must stay bounded"],
  ["DIV3RSA_PROBE_EVIDENCE_SAMPLE_BPS=100", "evidence must model one-percent sampling"],
  ["unset DIV3RSA_AGENT_KERNEL_V2_PROBES_ENABLED", "production probe enablement must be explicitly absent"],
  ["set +e", "gate exit must be captured without losing evidence"],
  ["__EVIDENCE_PATH__=", "remote evidence path marker missing"],
  ["__GATE_STATUS__=", "gate status marker missing"],
  ["scp_opts=(", "SCP must use options separate from SSH"],
  ['-P "$GPUHUB_SSH_PORT"', "SCP must use uppercase -P for port"],
  ['scp "${scp_opts[@]}"', "SCP must use the dedicated SCP options"],
  ["actions/upload-artifact@v4", "evidence artifact upload missing"],
  ["Enforce promotion gate result", "promotion gate must still be enforced after artifact upload"],
];
for (const [needle, message] of required) {
  if (!workflow.includes(needle)) throw new Error(message);
}

const runnerRequired = [
  ["selectedSampleIndexes", "runner must select only the intended sampled requests"],
  ["sampledRuns: withProbes ? sampledRuns : 0", "sampledRuns must count sampled requests, not all foreground requests"],
  ["actualSampleRate", "runner must record the effective sample rate"],
  ["every material request requirement", "quality verifier must use a strict completeness rubric"],
  ["score <70 when passed=false", "quality verifier score/pass contract missing"],
];
for (const [needle, message] of runnerRequired) {
  if (!runner.includes(needle)) throw new Error(message);
}

for (const needle of ["agent-kernel-quality-", "agent-kernel-evidence-probe-", 'reasoning_effort: "none"', "enable_thinking: false"]) {
  if (!preload.includes(needle)) throw new Error(`scoped verifier preload missing: ${needle}`);
}
if (preload.includes("agent-kernel-evidence-baseline-") || preload.includes("agent-kernel-evidence-loaded-")) {
  throw new Error("foreground benchmark requests must not disable thinking");
}
if (workflow.includes('scp "${ssh_opts[@]}"')) throw new Error("SCP must not reuse SSH -p port options");
if (workflow.indexOf("actions/upload-artifact@v4") > workflow.indexOf("Enforce promotion gate result")) {
  throw new Error("blocked evidence must be uploaded before promotion gate enforcement");
}
if (workflow.includes('workflows: ["Deploy GPUHub"]')) throw new Error("evidence must not race P8 soak after Deploy GPUHub");

const forbidden = [
  "rollback-legacy-gpuhub-p1.sh",
  "recover-legacy-gpuhub",
  "reconcile-gpuhub-production-profile.sh",
  "DIV3RSA_FORCE_MODEL_RESTART",
  "DIV3RSA_AGENT_KERNEL_V2_PROBES_ENABLED=1",
  "DIV3RSA_AGENT_KERNEL_V2_PROBE_SAMPLE_BPS=",
  "systemctl restart",
  "pkill",
  "killall"
];
for (const needle of forbidden) {
  if (workflow.includes(needle)) throw new Error(`observational evidence workflow contains forbidden mutation: ${needle}`);
}

if (!request.includes("productionSampling=false")) throw new Error("evidence request must explicitly keep production sampling disabled");
console.log("[agent-kernel-gpuhub-evidence-workflow] scoped no-thinking verifier calls + representative 1% evidence load present; normal traffic remains unchanged");
