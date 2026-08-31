#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const wrapper = await readFile(new URL("../infra/runtime/upgrade-legacy-gpuhub.sh", import.meta.url), "utf8");
const sync = await readFile(new URL("../infra/runtime/sync-security-skills.sh", import.meta.url), "utf8");
const runtime = await readFile(new URL("../packages/skill-engine/src/external-security-runtime.ts", import.meta.url), "utf8");
const validator = await readFile(new URL("./validate_security_skill_snapshot.mjs", import.meta.url), "utf8");
const integrityBuilder = await readFile(new URL("./build_security_skill_integrity.mjs", import.meta.url), "utf8");
const baseCall = wrapper.indexOf('bash "$BASE_SCRIPT" "$@"');
const syncResolve = wrapper.indexOf('SECURITY_SKILL_SYNC="${REPO_DIR}/infra/runtime/sync-security-skills.sh"');
const syncCall = wrapper.indexOf('bash "$SECURITY_SKILL_SYNC"');
const reconcileResolve = wrapper.indexOf('RECONCILE_SCRIPT="${REPO_DIR}/infra/runtime/reconcile-gpuhub-production-profile.sh"');

if (baseCall < 0) throw new Error("security_sync_cutover_missing_base_call");
if (syncResolve < 0 || syncCall < 0) throw new Error("security_sync_cutover_missing_post_checkout_sync");
if (reconcileResolve < 0) throw new Error("security_sync_cutover_missing_reconciler");
if (!(baseCall < syncResolve && syncResolve < syncCall && syncCall < reconcileResolve)) {
  throw new Error("security_sync_cutover_order_invalid");
}
if (!wrapper.includes('DIV3RSA_LEGACY_ROOT_DIR="$ROOT_DIR" DIV3RSA_LEGACY_APP_DIR="$REPO_DIR"')) {
  throw new Error("security_sync_cutover_runtime_roots_missing");
}

if (!sync.includes('DEFAULT_NODE_BIN="${ROOT_DIR}/runtime/node-current/bin/node"')) {
  throw new Error("security_sync_missing_runtime_node_default");
}
if (!sync.includes('NODE_BIN="${DIV3RSA_LEGACY_NODE_BIN:-$DEFAULT_NODE_BIN}"')) {
  throw new Error("security_sync_missing_node_override");
}
const integrityCall = sync.indexOf('"$NODE_BIN" "$REPO_DIR/scripts/build_security_skill_integrity.mjs" "$SNAPSHOT"');
const validateCall = sync.indexOf('"$NODE_BIN" "$REPO_DIR/scripts/validate_security_skill_snapshot.mjs" "$SNAPSHOT"');
if (integrityCall < 0) throw new Error("security_sync_integrity_builder_missing");
if (validateCall < 0) throw new Error("security_sync_validator_not_using_resolved_node");
if (!(integrityCall < validateCall)) throw new Error("security_sync_integrity_must_precede_validation");
if (!sync.includes('-f "$FINAL_DIR/integrity.json"')) throw new Error("security_sync_existing_snapshot_integrity_gate_missing");

if (!integrityBuilder.includes('snapshotSha256')) throw new Error("security_sync_integrity_aggregate_digest_missing");
if (!integrityBuilder.includes('createHash("sha256")')) throw new Error("security_sync_integrity_sha256_missing");
if (!validator.includes("snapshot_integrity_mismatch:")) throw new Error("security_sync_validator_file_hash_gate_missing");
if (!validator.includes("snapshot_integrity_digest_mismatch")) throw new Error("security_sync_validator_aggregate_hash_gate_missing");
if (!runtime.includes("external_security_skill_integrity_mismatch:")) throw new Error("security_sync_runtime_integrity_gate_missing");
if (!runtime.includes('safeRelativePath(this.snapshotRoot, "integrity.json")')) throw new Error("security_sync_runtime_integrity_lock_missing");

console.log("SECURITY_SKILL_SYNC_CUTOVER_OK");
