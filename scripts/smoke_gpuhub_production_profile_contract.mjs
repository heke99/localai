import { readFile } from "node:fs/promises";

const profile = await readFile("infra/runtime/gpuhub-production-profile.env", "utf8");
const recovery = await readFile("infra/runtime/recover-legacy-gpuhub-v2.sh", "utf8");
const recoveryWrapper = await readFile("infra/runtime/recover-legacy-gpuhub.sh", "utf8");
const upgradeWrapper = await readFile("infra/runtime/upgrade-legacy-gpuhub.sh", "utf8");
const reconcile = await readFile("infra/runtime/reconcile-gpuhub-production-profile.sh", "utf8");
const rollback = await readFile("infra/runtime/rollback-legacy-gpuhub-p1.sh", "utf8");
const workflow = await readFile(".github/workflows/p8-promotion-verify.yml", "utf8");

const readNumber = (name) => {
  const match = profile.match(new RegExp(`^${name}=(\\d+)$`, "m"));
  if (!match) throw new Error(`missing numeric production profile value: ${name}`);
  return Number(match[1]);
};

const parallel = readNumber("DIV3RSA_GPUHUB_PRODUCTION_PARALLEL");
const totalContext = readNumber("DIV3RSA_GPUHUB_PRODUCTION_TOTAL_CONTEXT");
const perSlot = readNumber("DIV3RSA_GPUHUB_PRODUCTION_CONTEXT_PER_SLOT");
if (parallel !== 8) throw new Error(`GPUHub production parallel must be 8, got ${parallel}`);
if (totalContext !== 262144) throw new Error(`GPUHub production total context must be 262144, got ${totalContext}`);
if (perSlot !== 32768) throw new Error(`GPUHub production context per slot must be 32768, got ${perSlot}`);
if (parallel * perSlot !== totalContext) throw new Error("GPUHub production profile loses per-slot context");

const checks = [
  [recovery.includes("REQUESTED_MODEL_PARALLEL"), "recovery command-scoped parallel override missing"],
  [recovery.includes("REQUESTED_MODEL_TOTAL_CONTEXT"), "recovery command-scoped total-context override missing"],
  [recovery.includes("DIV3RSA_FORCE_MODEL_RESTART"), "forced recovery/profile reconciliation missing"],
  [recovery.includes("gpuhub-model-profile-override.env"), "emergency runtime override support missing"],
  [recoveryWrapper.includes("recover-legacy-gpuhub-v2.sh"), "canonical recovery does not dispatch to v2"],
  [upgradeWrapper.includes("upgrade-legacy-gpuhub-base.sh"), "upgrade compatibility base missing"],
  [upgradeWrapper.includes("reconcile-gpuhub-production-profile.sh"), "upgrade does not reconcile tracked profile"],
  [reconcile.includes("TARGET_PARALLEL") && reconcile.includes("TARGET_TOTAL_CONTEXT"), "profile reconciler target validation missing"],
  [reconcile.includes("verify_target"), "profile reconciler post-restart verification missing"],
  [reconcile.includes("VERIFY_ATTEMPTS") && reconcile.includes("tracked profile verification pending attempt"), "profile reconciler transient verification retry missing"],
  [rollback.includes("DIV3RSA_GPUHUB_OVERRIDE_PARALLEL=1"), "explicit p1 emergency rollback missing"],
  [rollback.includes("DIV3RSA_FORCE_MODEL_RESTART=1 \\") && rollback.includes("DIV3RSA_MODEL_PARALLEL=1 \\") && rollback.includes("DIV3RSA_MODEL_CONTEXT_SIZE=32768"), "p1 rollback does not override inherited p8 recovery values"],
  [workflow.includes('result.get("passed") != 8') && workflow.includes('result.get("liveOracleFailures") != []') && workflow.includes('result.get("modelParallel") != expected_parallel'), "post-promotion 8/8 agent gate missing"],
  [workflow.includes("rollback-legacy-gpuhub-p1.sh"), "post-promotion failure rollback missing"],
];
for (const [ok, message] of checks) if (!ok) throw new Error(message);

console.log("[gpuhub-production-profile] durable p8/262144 profile, retrying verification, p1 rollback and post-promotion 8/8 gate present");