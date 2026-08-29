import { readFile } from "node:fs/promises";

const workflow = await readFile(".github/workflows/agent-kernel-gpuhub-evidence.yml", "utf8");
const request = await readFile("ops/agent-kernel-gpuhub-evidence.request", "utf8");

const required = [
  ['workflows: ["P8 GPUHub Soak"]', "workflow_run must follow P8 GPUHub Soak"],
  ["environment: production-gpuhub", "production-gpuhub environment missing"],
  ["GPUHUB_SSH_KNOWN_HOSTS", "pinned SSH known-hosts missing"],
  ["StrictHostKeyChecking=yes", "strict host checking missing"],
  ["ops/agent-kernel-gpuhub-evidence.request", "explicit request gate missing"],
  ["scripts/eval_agent_kernel_probes_gpuhub.mjs", "evidence runner invocation missing"],
  ["--parallel[=\\ ]+8", "p8 runtime verification missing"],
  ["--ctx-size[=\\ ]+262144", "p8 context verification missing"],
  ["--spec-type ngram-mod", "speculative profile verification missing"],
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
console.log("[agent-kernel-gpuhub-evidence-workflow] SCP uses uppercase -P, blocked evidence is preserved before fail-closed enforcement, runtime remains observational-only");
