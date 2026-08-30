#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const wrapper = await readFile(new URL("../infra/runtime/upgrade-legacy-gpuhub.sh", import.meta.url), "utf8");
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

console.log("SECURITY_SKILL_SYNC_CUTOVER_OK");
