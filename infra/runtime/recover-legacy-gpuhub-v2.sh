#!/usr/bin/env bash
set -Eeuo pipefail

log() { printf '[gpuhub-recovery-v2] %s\n' "$*"; }
fatal() { log "$*" >&2; exit 1; }

[[ "${EUID}" -eq 0 ]] || fatal "run as root on the GPUHub host"

ROOT_DIR="${DIV3RSA_LEGACY_ROOT_DIR:-/root/autodl-tmp/localai}"
REPO_DIR="${DIV3RSA_LEGACY_APP_DIR:-${ROOT_DIR}/app}"
ENV_FILE="${DIV3RSA_LEGACY_ENV_FILE:-${ROOT_DIR}/secrets/gpuhub-worker.env}"
LOG_DIR="${DIV3RSA_LEGACY_LOG_DIR:-${ROOT_DIR}/logs}"
NODE_BIN="${DIV3RSA_LEGACY_NODE_BIN:-${ROOT_DIR}/runtime/node-current/bin/node}"
SCREEN_NAME="${DIV3RSA_LEGACY_WORKER_SCREEN:-localai-agent}"
MODEL_PORT="${DIV3RSA_MODEL_PORT:-6006}"
MODEL_BIN="${DIV3RSA_LLAMA_SERVER_BIN:-${ROOT_DIR}/runtime/llama.cpp/build/bin/llama-server}"
MODEL_PATH="${DIV3RSA_MODEL_PATH:-${ROOT_DIR}/models/qwen/current/Qwen3.8-27B-OBLITERATED-Q8_0.gguf}"
MODEL_ALIAS="${DIV3RSA_MODEL_RUNTIME_ALIAS:-localai-qwen38-v3-q8}"
API_KEY_FILE="${DIV3RSA_INFERENCE_API_KEY_FILE:-${ROOT_DIR}/secrets/inference-api-key}"
MODEL_BATCH_SIZE="${DIV3RSA_MODEL_BATCH_SIZE:-2048}"
MODEL_UBATCH_SIZE="${DIV3RSA_MODEL_UBATCH_SIZE:-512}"
MODEL_BOOT_TIMEOUT_SECONDS="${DIV3RSA_MODEL_BOOT_TIMEOUT_SECONDS:-900}"
MODEL_RECOVERY_ATTEMPTS="${DIV3RSA_MODEL_RECOVERY_ATTEMPTS:-3}"
FORCE_MODEL_RESTART="${DIV3RSA_FORCE_MODEL_RESTART:-0}"
PROFILE_FILE="${DIV3RSA_GPUHUB_PRODUCTION_PROFILE_FILE:-${REPO_DIR}/infra/runtime/gpuhub-production-profile.env}"
OVERRIDE_FILE="${DIV3RSA_GPUHUB_RUNTIME_PROFILE_OVERRIDE_FILE:-${ROOT_DIR}/secrets/gpuhub-model-profile-override.env}"
RECOVERY_LOG="${LOG_DIR}/llama-recovery.log"
PID_FILE="${ROOT_DIR}/runtime/qwen.pid"

# Capture command-scoped overrides before persistent worker state is sourced.
# This preserves the existing benchmark/soak rollback contract while letting the
# durable tracked profile become the normal production default.
REQUESTED_MODEL_PARALLEL="${DIV3RSA_MODEL_PARALLEL:-}"
REQUESTED_MODEL_TOTAL_CONTEXT="${DIV3RSA_MODEL_CONTEXT_SIZE:-}"
REQUESTED_MODEL_SPEC_TYPE="${DIV3RSA_MODEL_SPEC_TYPE:-}"

[[ -d "$REPO_DIR" ]] || fatal "repository missing: $REPO_DIR"
[[ -f "$ENV_FILE" ]] || fatal "worker env missing: $ENV_FILE"
[[ -x "$MODEL_BIN" ]] || fatal "llama-server missing: $MODEL_BIN"
[[ -f "$MODEL_PATH" ]] || fatal "model missing: $MODEL_PATH"
[[ -r "$API_KEY_FILE" ]] || fatal "inference api key file missing: $API_KEY_FILE"
[[ -x "$NODE_BIN" ]] || fatal "Node runtime missing: $NODE_BIN"
command -v curl >/dev/null 2>&1 || fatal "curl is missing"
command -v screen >/dev/null 2>&1 || fatal "screen is missing"
mkdir -p "$LOG_DIR" "$(dirname "$PID_FILE")"

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

# These defaults match the promotion target so the target-revision recovery
# remains safe during the small pre-checkout window of the first deploy.
PROFILE_PARALLEL=8
PROFILE_TOTAL_CONTEXT=262144
PROFILE_CONTEXT_PER_SLOT=32768
PROFILE_SPEC_TYPE=ngram-mod
if [[ -f "$PROFILE_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$PROFILE_FILE"
  PROFILE_PARALLEL="${DIV3RSA_GPUHUB_PRODUCTION_PARALLEL:-$PROFILE_PARALLEL}"
  PROFILE_TOTAL_CONTEXT="${DIV3RSA_GPUHUB_PRODUCTION_TOTAL_CONTEXT:-$PROFILE_TOTAL_CONTEXT}"
  PROFILE_CONTEXT_PER_SLOT="${DIV3RSA_GPUHUB_PRODUCTION_CONTEXT_PER_SLOT:-$PROFILE_CONTEXT_PER_SLOT}"
  PROFILE_SPEC_TYPE="${DIV3RSA_GPUHUB_PRODUCTION_SPEC_TYPE:-$PROFILE_SPEC_TYPE}"
fi

OVERRIDE_PARALLEL=""
OVERRIDE_TOTAL_CONTEXT=""
OVERRIDE_SPEC_TYPE=""
if [[ -f "$OVERRIDE_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$OVERRIDE_FILE"
  OVERRIDE_PARALLEL="${DIV3RSA_GPUHUB_OVERRIDE_PARALLEL:-}"
  OVERRIDE_TOTAL_CONTEXT="${DIV3RSA_GPUHUB_OVERRIDE_TOTAL_CONTEXT:-}"
  OVERRIDE_SPEC_TYPE="${DIV3RSA_GPUHUB_OVERRIDE_SPEC_TYPE:-}"
fi

MODEL_PARALLEL="${REQUESTED_MODEL_PARALLEL:-${OVERRIDE_PARALLEL:-$PROFILE_PARALLEL}}"
MODEL_TOTAL_CONTEXT="${REQUESTED_MODEL_TOTAL_CONTEXT:-${OVERRIDE_TOTAL_CONTEXT:-$PROFILE_TOTAL_CONTEXT}}"
MODEL_SPEC_TYPE="${REQUESTED_MODEL_SPEC_TYPE:-${OVERRIDE_SPEC_TYPE:-$PROFILE_SPEC_TYPE}}"

for value_name in MODEL_PARALLEL MODEL_TOTAL_CONTEXT PROFILE_CONTEXT_PER_SLOT; do
  value="${!value_name}"
  [[ "$value" =~ ^[0-9]+$ && "$value" -ge 1 ]] || fatal "invalid ${value_name}: $value"
done
(( MODEL_TOTAL_CONTEXT % MODEL_PARALLEL == 0 )) || fatal "total context must divide evenly across parallel slots"
MODEL_CONTEXT_PER_SLOT=$((MODEL_TOTAL_CONTEXT / MODEL_PARALLEL))
[[ "$MODEL_CONTEXT_PER_SLOT" -ge "$PROFILE_CONTEXT_PER_SLOT" ]] \
  || fatal "resolved context per slot ${MODEL_CONTEXT_PER_SLOT} is below required ${PROFILE_CONTEXT_PER_SLOT}"
case "$MODEL_SPEC_TYPE" in
  none|ngram-mod) ;;
  *) fatal "unsupported production speculative decoder: ${MODEL_SPEC_TYPE}" ;;
esac

health() {
  curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:${MODEL_PORT}/health" >/dev/null 2>&1
}

read_active_profile() {
  local pid cmd
  mapfile -t pids < <(pgrep -f 'llama-server.*Qwen3\.8-27B-OBLITERATED-Q8_0\.gguf' || true)
  [[ "${#pids[@]}" -eq 1 ]] || return 1
  pid="${pids[0]}"
  cmd="$(tr '\0' ' ' <"/proc/${pid}/cmdline")"
  ACTIVE_PARALLEL="$(sed -nE 's/.*--parallel[= ]+([0-9]+).*/\1/p' <<<"$cmd")"
  ACTIVE_TOTAL_CONTEXT="$(sed -nE 's/.*--ctx-size[= ]+([0-9]+).*/\1/p' <<<"$cmd")"
  ACTIVE_SPEC_TYPE="$(sed -nE 's/.*--spec-type[= ]+([^ ]+).*/\1/p' <<<"$cmd")"
  [[ -n "$ACTIVE_SPEC_TYPE" ]] || ACTIVE_SPEC_TYPE=none
  [[ "$ACTIVE_PARALLEL" =~ ^[0-9]+$ && "$ACTIVE_TOTAL_CONTEXT" =~ ^[0-9]+$ ]] || return 1
  (( ACTIVE_TOTAL_CONTEXT % ACTIVE_PARALLEL == 0 )) || return 1
  ACTIVE_CONTEXT_PER_SLOT=$((ACTIVE_TOTAL_CONTEXT / ACTIVE_PARALLEL))
  ACTIVE_PID="$pid"
}

start_worker() {
  local parallel="$1" context_per_slot="$2"
  screen -S "$SCREEN_NAME" -X quit >/dev/null 2>&1 || true
  screen -dmS "$SCREEN_NAME" bash -lc "
    set -Eeuo pipefail
    export PATH='$(dirname "$NODE_BIN")':\$PATH
    set -a
    source '$ENV_FILE'
    set +a
    export DIV3RSA_MODEL_PARALLEL='$parallel'
    export DIV3RSA_MODEL_CONTEXT_SIZE='$context_per_slot'
    cd '$REPO_DIR'
    exec node --experimental-transform-types --import ./infra/runpod/native-typescript-register.mjs services/agent-worker/src/main.ts >>'$LOG_DIR/agent-worker.log' 2>&1
  "
  sleep 3
  screen -list | grep -F ".${SCREEN_NAME}" >/dev/null || fatal "agent worker failed to start"
}

if health && [[ "$FORCE_MODEL_RESTART" != "1" ]]; then
  log "Qwen already healthy on 127.0.0.1:${MODEL_PORT}"
  if ! screen -list | grep -F ".${SCREEN_NAME}" >/dev/null; then
    read_active_profile || fatal "could not read healthy Qwen runtime profile"
    log "agent worker is missing; restarting it against active parallel=${ACTIVE_PARALLEL} context_per_slot=${ACTIVE_CONTEXT_PER_SLOT}"
    start_worker "$ACTIVE_PARALLEL" "$ACTIVE_CONTEXT_PER_SLOT"
  fi
  exit 0
fi

if [[ "$FORCE_MODEL_RESTART" == "1" ]]; then
  log "forced profile reconciliation requested: parallel=${MODEL_PARALLEL} total_context=${MODEL_TOTAL_CONTEXT} context_per_slot=${MODEL_CONTEXT_PER_SLOT} spec_type=${MODEL_SPEC_TYPE}"
else
  log "Qwen is unhealthy; beginning recovery with parallel=${MODEL_PARALLEL} total_context=${MODEL_TOTAL_CONTEXT} spec_type=${MODEL_SPEC_TYPE}"
fi
screen -S "$SCREEN_NAME" -X quit >/dev/null 2>&1 || true

mapfile -t stale_pids < <(pgrep -f 'llama-server.*Qwen3\.8-27B-OBLITERATED-Q8_0\.gguf' || true)
for pid in "${stale_pids[@]}"; do kill -TERM "$pid" >/dev/null 2>&1 || true; done
for _ in {1..60}; do
  remaining="$(pgrep -f 'llama-server.*Qwen3\.8-27B-OBLITERATED-Q8_0\.gguf' || true)"
  [[ -z "$remaining" ]] && break
  sleep 0.5
done
mapfile -t stale_pids < <(pgrep -f 'llama-server.*Qwen3\.8-27B-OBLITERATED-Q8_0\.gguf' || true)
for pid in "${stale_pids[@]}"; do kill -KILL "$pid" >/dev/null 2>&1 || true; done
sleep 3

MODEL_CMD=(
  "$MODEL_BIN"
  --model "$MODEL_PATH"
  --alias "$MODEL_ALIAS"
  --host 0.0.0.0
  --port "$MODEL_PORT"
  --api-key-file "$API_KEY_FILE"
  -ngl all
  --ctx-size "$MODEL_TOTAL_CONTEXT"
  --parallel "$MODEL_PARALLEL"
  --cont-batching
  --flash-attn on
  --batch-size "$MODEL_BATCH_SIZE"
  --ubatch-size "$MODEL_UBATCH_SIZE"
  --no-webui
)
if [[ "$MODEL_SPEC_TYPE" != "none" ]]; then
  MODEL_CMD+=(--spec-type "$MODEL_SPEC_TYPE")
fi

for ((attempt=1; attempt<=MODEL_RECOVERY_ATTEMPTS; attempt+=1)); do
  printf '\n=== %s recovery-v2 attempt %d/%d parallel=%s total_context=%s spec_type=%s ===\n' \
    "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$attempt" "$MODEL_RECOVERY_ATTEMPTS" "$MODEL_PARALLEL" "$MODEL_TOTAL_CONTEXT" "$MODEL_SPEC_TYPE" >>"$RECOVERY_LOG"
  nohup "${MODEL_CMD[@]}" </dev/null >>"$RECOVERY_LOG" 2>&1 &
  model_pid=$!
  printf '%s\n' "$model_pid" >"$PID_FILE"
  deadline=$((SECONDS + MODEL_BOOT_TIMEOUT_SECONDS))

  while true; do
    if health; then
      log "Qwen recovered on attempt ${attempt}; pid=${model_pid} parallel=${MODEL_PARALLEL} total_context=${MODEL_TOTAL_CONTEXT} spec_type=${MODEL_SPEC_TYPE}"
      start_worker "$MODEL_PARALLEL" "$MODEL_CONTEXT_PER_SLOT"
      health || fatal "Qwen became unhealthy after worker restart"
      log "recovery complete; Qwen and agent worker are healthy"
      exit 0
    fi
    if ! kill -0 "$model_pid" 2>/dev/null; then
      log "llama-server exited during recovery attempt ${attempt}"
      tail -n 80 "$RECOVERY_LOG" >&2 || true
      break
    fi
    if (( SECONDS >= deadline )); then
      log "recovery attempt ${attempt} exceeded ${MODEL_BOOT_TIMEOUT_SECONDS}s"
      kill -TERM "$model_pid" >/dev/null 2>&1 || true
      sleep 2
      kill -KILL "$model_pid" >/dev/null 2>&1 || true
      break
    fi
    sleep 2
  done
  sleep $((attempt * 5))
done

fatal "Qwen recovery failed after ${MODEL_RECOVERY_ATTEMPTS} attempts; inspect ${RECOVERY_LOG}"
