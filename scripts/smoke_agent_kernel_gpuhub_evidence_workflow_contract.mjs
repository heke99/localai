import { readFile } from "node:fs/promises";

const workflow = await readFile(".github/workflows/agent-kernel-gpuhub-evidence.yml", "utf8");
const request = await readFile("ops/agent-kernel-gpuhub-evidence.request", "utf8");

const required = [
  ['workflows: ["Deploy GPUHub"]', "workflow_run must follow Deploy GPUHub"],
  ["environment: production-gpuhub", "production-gpuhub environment missing"],
  ["GPUHUB_SSH_KNOWN_HOSTS", "pinned SSH known-hosts missing"],
  ["StrictHostKeyChecking=yes", "strict host checking missing"],
  ["ops/agent-kernel-gpuhub-evidence.request", "explicit request gate missing"],
  ["scripts/eval_agent_kernel_probes_gpuhub.mjs", "evidence runner invocation missing"],
  ["--parallel[=\\ ]+8", "p8 runtime verification missing"],
  ["--ctx-size[=\\ ]+262144", "p8 context verification missing"],
  ["--spec-type ngram-mod", "speculative profile verification missing"],
  ["unset DIV3RSA_AGENT_KERNEL_V2_PROBES_ENABLED", "production probe enablement must be explicitly absent"],
  ["actions/upload-artifact@v4", "evidence artifact upload missing"],
];
for (const [needle, message] of required) {
  if (!workflow.includes(needle)) throw new Error(message);
}

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
console.log("[agent-kernel-gpuhub-evidence-workflow] pinned SSH, explicit request, p8 pre/post checks, observational-only evidence and artifact upload present");
