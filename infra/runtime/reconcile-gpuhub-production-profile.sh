#!/usr/bin/env bash
set -Eeuo pipefail

log() { printf '[gpuhub-profile] %s\n' "$*"; }
fatal() { log "$*" >&2; exit 1; }

[[ "${EUID}" -eq 0 ]] || fatal "run as root on the GPUHub host"
ROOT_DIR="${DIV3RSA_LEGACY_ROOT_DIR:-/root/autodl-tmp/localai}"
REPO_DIR="${DIV3RSA_LEGACY_APP_DIR:-${ROOT_DIR}/app}"
ENV_FILE="${DIV3RSA_LEGACY_ENV_FILE:-${ROOT_DIR}/secrets/gpuhub-worker.env}"
PROFILE_FILE="${DIV3RSA_GPUHUB_PRODUCTION_PROFILE_FILE:-${REPO_DIR}/infra/runtime/gpuhub-production-profile.env}"
OVERRIDE_FILE="${DIV3RSA_GPUHUB_RUNTIME_PROFILE_OVERRIDE_FILE:-${ROOT_DIR}/secrets/gpuhub-model-profile-override.env}"
RECOVERY_SCRIPT="${REPO_DIR}/infra/runtime/recover-legacy-gpuhub.sh"
SEARCH_CHECK="${REPO_DIR}/infra/runtime/check-search-capability.sh"
MODEL_PORT="${DIV3RSA_MODEL_PORT:-6006}"
SCREEN_NAME="${DIV3RSA_LEGACY_WORKER_SCREEN:-localai-agent}"
API_KEY_FILE="${DIV3RSA_INFERENCE_API_KEY_FILE:-${ROOT_DIR}/secrets/inference-api-key}"
VERIFY_ATTEMPTS="${DIV3RSA_GPUHUB_PROFILE_VERIFY_ATTEMPTS:-15}"
VERIFY_POLL_SECONDS="${DIV3RSA_GPUHUB_PROFILE_VERIFY_POLL_SECONDS:-1}"
ENV_BACKUP=""
BEFORE_PARALLEL=""
BEFORE_TOTAL_CONTEXT=""
MUTATED=0
PROFILE_READ_DETAIL="not_checked"
VERIFY_DETAIL="not_checked"

[[ -f "$PROFILE_FILE" ]] || fatal "tracked GPUHub production profile missing: $PROFILE_FILE"
[[ -f "$ENV_FILE" ]] || fatal "worker env missing: $ENV_FILE"
[[ -f "$RECOVERY_SCRIPT" ]] || fatal "recovery script missing: $RECOVERY_SCRIPT"
[[ -f "$SEARCH_CHECK" ]] || fatal "search checker missing: $SEARCH_CHECK"
[[ -r "$API_KEY_FILE" ]] || fatal "inference API key file missing: $API_KEY_FILE"
[[ "$VERIFY_ATTEMPTS" =~ ^[0-9]+$ && "$VERIFY_ATTEMPTS" -ge 1 ]] || fatal "invalid verification attempts: $VERIFY_ATTEMPTS"
[[ "$VERIFY_POLL_SECONDS" =~ ^[0-9]+([.][0-9]+)?$ ]] || fatal "invalid verification poll seconds: $VERIFY_POLL_SECONDS"
# shellcheck disable=SC1090
source "$PROFILE_FILE"
TARGET_PARALLEL="${DIV3RSA_GPUHUB_PRODUCTION_PARALLEL:-}"
TARGET_TOTAL_CONTEXT="${DIV3RSA_GPUHUB_PRODUCTION_TOTAL_CONTEXT:-}"
TARGET_CONTEXT_PER_SLOT="${DIV3RSA_GPUHUB_PRODUCTION_CONTEXT_PER_SLOT:-}"
for name in TARGET_PARALLEL TARGET_TOTAL_CONTEXT TARGET_CONTEXT_PER_SLOT; do
  value="${!name}"
  [[ "$value" =~ ^[0-9]+$ && "$value" -ge 1 ]] || fatal "invalid $name: $value"
done
[[ "$TARGET_TOTAL_CONTEXT" -eq $((TARGET_PARALLEL * TARGET_CONTEXT_PER_SLOT)) ]] \
  || fatal "tracked profile does not preserve context per slot"

ensure_env_value() {
  local key="$1" value="$2"
  python3 - "$ENV_FILE" "$key" "$value" <<'PY'
from pathlib import Path
import re, shlex, sys
path=Path(sys.argv[1]); key=sys.argv[2]; value=sys.argv[3]
text=path.read_text(encoding="utf-8")
pattern=re.compile(rf"^(?:export\s+)?{re.escape(key)}=.*$", re.M)
line=f"export {key}={shlex.quote(value)}"
if pattern.search(text): text=pattern.sub(line, text)
else: text += ("" if not text or text.endswith("\n") else "\n") + line + "\n"
path.write_text(text, encoding="utf-8")
PY
  chmod 600 "$ENV_FILE"
}

read_active_profile() {
  local cmd
  mapfile -t pids < <(pgrep -f 'llama-server.*Qwen3\.8-27B-OBLITERATED-Q8_0\.gguf' || true)
  if [[ "${#pids[@]}" -ne 1 ]]; then
    PROFILE_READ_DETAIL="llama_process_count=${#pids[@]}"
    return 1
  fi
  cmd="$(tr '\0' ' ' <"/proc/${pids[0]}/cmdline")"
  ACTIVE_PARALLEL="$(sed -nE 's/.*--parallel[= ]+([0-9]+).*/\1/p' <<<"$cmd")"
  ACTIVE_TOTAL_CONTEXT="$(sed -nE 's/.*--ctx-size[= ]+([0-9]+).*/\1/p' <<<"$cmd")"
  if [[ ! "$ACTIVE_PARALLEL" =~ ^[0-9]+$ || ! "$ACTIVE_TOTAL_CONTEXT" =~ ^[0-9]+$ ]]; then
    PROFILE_READ_DETAIL="llama_profile_flags_unreadable"
    return 1
  fi
  PROFILE_READ_DETAIL="parallel=${ACTIVE_PARALLEL} total_context=${ACTIVE_TOTAL_CONTEXT}"
}

verify_target_once() {
  local reported
  if ! read_active_profile; then
    VERIFY_DETAIL="$PROFILE_READ_DETAIL"
    return 1
  fi
  if [[ "$ACTIVE_PARALLEL" != "$TARGET_PARALLEL" || "$ACTIVE_TOTAL_CONTEXT" != "$TARGET_TOTAL_CONTEXT" ]]; then
    VERIFY_DETAIL="profile_mismatch active=${ACTIVE_PARALLEL}/${ACTIVE_TOTAL_CONTEXT} target=${TARGET_PARALLEL}/${TARGET_TOTAL_CONTEXT}"
    return 1
  fi
  if ! curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:${MODEL_PORT}/health" >/dev/null; then
    VERIFY_DETAIL="model_health_unavailable"
    return 1
  fi
  if ! screen -list | grep -F ".${SCREEN_NAME}" >/dev/null; then
    VERIFY_DETAIL="worker_screen_missing"
    return 1
  fi
  if ! bash "$SEARCH_CHECK" http://127.0.0.1:8890 >/dev/null; then
    VERIFY_DETAIL="search_unavailable"
    return 1
  fi
  if ! reported="$(curl --fail --silent --show-error --max-time 5 \
    -H "Authorization: Bearer $(head -n1 "$API_KEY_FILE")" \
    "http://127.0.0.1:${MODEL_PORT}/props" | python3 -c 'import json,sys; v=json.load(sys.stdin).get("default_generation_settings",{}).get("n_ctx"); print(v if isinstance(v,int) else "")')"; then
    VERIFY_DETAIL="model_props_unavailable"
    return 1
  fi
  if [[ ! "$reported" =~ ^[0-9]+$ || "$reported" -lt "$TARGET_CONTEXT_PER_SLOT" ]]; then
    VERIFY_DETAIL="reported_context_too_small reported=${reported:-missing} required=${TARGET_CONTEXT_PER_SLOT}"
    return 1
  fi
  VERIFY_DETAIL="ok active=${ACTIVE_PARALLEL}/${ACTIVE_TOTAL_CONTEXT} reported_context=${reported}"
}

verify_target() {
  local attempt
  for ((attempt=1; attempt<=VERIFY_ATTEMPTS; attempt++)); do
    if verify_target_once; then
      [[ "$attempt" -gt 1 ]] && log "tracked profile verification stabilized on attempt ${attempt}/${VERIFY_ATTEMPTS}: ${VERIFY_DETAIL}"
      return 0
    fi
    log "tracked profile verification pending attempt ${attempt}/${VERIFY_ATTEMPTS}: ${VERIFY_DETAIL}"
    [[ "$attempt" -lt "$VERIFY_ATTEMPTS" ]] && sleep "$VERIFY_POLL_SECONDS"
  done
  return 1
}

rollback_on_exit() {
  status=$?
  trap - EXIT
  if [[ "$status" -eq 0 || "$MUTATED" -ne 1 ]]; then exit "$status"; fi
  set +e
  log "profile reconciliation failed; restoring previous runtime parallel=${BEFORE_PARALLEL} total_context=${BEFORE_TOTAL_CONTEXT}"
  [[ -n "$ENV_BACKUP" && -f "$ENV_BACKUP" ]] && cp "$ENV_BACKUP" "$ENV_FILE" && chmod 600 "$ENV_FILE"
  DIV3RSA_FORCE_MODEL_RESTART=1 \
  DIV3RSA_MODEL_PARALLEL="$BEFORE_PARALLEL" \
  DIV3RSA_MODEL_CONTEXT_SIZE="$BEFORE_TOTAL_CONTEXT" \
    bash "$RECOVERY_SCRIPT"
  if [[ $? -eq 0 ]]; then log "previous runtime profile restored after failed promotion"; else log "CRITICAL: failed to restore previous runtime profile"; fi
  [[ -n "$ENV_BACKUP" ]] && rm -f "$ENV_BACKUP"
  exit "$status"
}
trap rollback_on_exit EXIT

read_active_profile || fatal "could not read active llama.cpp profile before reconciliation: ${PROFILE_READ_DETAIL}"
BEFORE_PARALLEL="$ACTIVE_PARALLEL"
BEFORE_TOTAL_CONTEXT="$ACTIVE_TOTAL_CONTEXT"
ENV_BACKUP="$(mktemp /tmp/div3rsa-gpuhub-env.XXXXXX)"
cp "$ENV_FILE" "$ENV_BACKUP"
chmod 600 "$ENV_BACKUP"

# A successful durable deploy clears any prior emergency runtime-only override.
rm -f "$OVERRIDE_FILE"
ensure_env_value DIV3RSA_MODEL_PARALLEL "$TARGET_PARALLEL"
# Worker-side model context is per request/slot, not llama.cpp total context.
ensure_env_value DIV3RSA_MODEL_CONTEXT_SIZE "$TARGET_CONTEXT_PER_SLOT"
MUTATED=1

if [[ "$BEFORE_PARALLEL" != "$TARGET_PARALLEL" || "$BEFORE_TOTAL_CONTEXT" != "$TARGET_TOTAL_CONTEXT" ]]; then
  log "reconciling llama.cpp ${BEFORE_PARALLEL}/${BEFORE_TOTAL_CONTEXT} -> ${TARGET_PARALLEL}/${TARGET_TOTAL_CONTEXT}"
  DIV3RSA_FORCE_MODEL_RESTART=1 \
  DIV3RSA_MODEL_PARALLEL="$TARGET_PARALLEL" \
  DIV3RSA_MODEL_CONTEXT_SIZE="$TARGET_TOTAL_CONTEXT" \
    bash "$RECOVERY_SCRIPT"
else
  log "llama.cpp already matches tracked production profile ${TARGET_PARALLEL}/${TARGET_TOTAL_CONTEXT}"
fi

verify_target || fatal "tracked production profile verification failed after ${VERIFY_ATTEMPTS} attempts: ${VERIFY_DETAIL}"
MUTATED=0
rm -f "$ENV_BACKUP"
trap - EXIT
log "production profile active: parallel=${TARGET_PARALLEL} total_context=${TARGET_TOTAL_CONTEXT} context_per_slot=${TARGET_CONTEXT_PER_SLOT}"