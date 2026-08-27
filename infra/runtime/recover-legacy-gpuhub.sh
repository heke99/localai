#!/usr/bin/env bash
set -Eeuo pipefail

log() { printf '[gpuhub-recovery] %s\n' "$*"; }
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
MODEL_CONTEXT_SIZE="${DIV3RSA_MODEL_CONTEXT_SIZE:-32768}"
MODEL_BATCH_SIZE="${DIV3RSA_MODEL_BATCH_SIZE:-2048}"
MODEL_UBATCH_SIZE="${DIV3RSA_MODEL_UBATCH_SIZE:-512}"
MODEL_BOOT_TIMEOUT_SECONDS="${DIV3RSA_MODEL_BOOT_TIMEOUT_SECONDS:-900}"
MODEL_RECOVERY_ATTEMPTS="${DIV3RSA_MODEL_RECOVERY_ATTEMPTS:-3}"
RECOVERY_LOG="${LOG_DIR}/llama-recovery.log"
PID_FILE="${ROOT_DIR}/runtime/qwen.pid"

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
MODEL_PARALLEL="${DIV3RSA_MODEL_PARALLEL:-1}"
[[ "$MODEL_PARALLEL" =~ ^[0-9]+$ && "$MODEL_PARALLEL" -ge 1 ]] || fatal "invalid DIV3RSA_MODEL_PARALLEL: $MODEL_PARALLEL"

health() {
  curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:${MODEL_PORT}/health" >/dev/null 2>&1
}

start_worker() {
  screen -S "$SCREEN_NAME" -X quit >/dev/null 2>&1 || true
  screen -dmS "$SCREEN_NAME" bash -lc "
    set -Eeuo pipefail
    export PATH='$(dirname "$NODE_BIN")':\$PATH
    set -a
    source '$ENV_FILE'
    set +a
    export DIV3RSA_MODEL_PARALLEL='$MODEL_PARALLEL'
    cd '$REPO_DIR'
    exec node --experimental-transform-types --import ./infra/runpod/native-typescript-register.mjs services/agent-worker/src/main.ts >>'$LOG_DIR/agent-worker.log' 2>&1
  "
  sleep 3
  screen -list | grep -F ".${SCREEN_NAME}" >/dev/null || fatal "agent worker failed to start"
}

if health; then
  log "Qwen already healthy on 127.0.0.1:${MODEL_PORT}"
  if ! screen -list | grep -F ".${SCREEN_NAME}" >/dev/null; then
    log "agent worker is missing; restarting it"
    start_worker
  fi
  exit 0
fi

log "Qwen is unhealthy; beginning recovery with parallel=${MODEL_PARALLEL}"
mapfile -t stale_pids < <(pgrep -f 'llama-server.*Qwen3\.8-27B-OBLITERATED-Q8_0\.gguf' || true)
for pid in "${stale_pids[@]}"; do
  kill -TERM "$pid" >/dev/null 2>&1 || true
done
for _ in {1..60}; do
  remaining="$(pgrep -f 'llama-server.*Qwen3\.8-27B-OBLITERATED-Q8_0\.gguf' || true)"
  [[ -z "$remaining" ]] && break
  sleep 0.5
done
mapfile -t stale_pids < <(pgrep -f 'llama-server.*Qwen3\.8-27B-OBLITERATED-Q8_0\.gguf' || true)
for pid in "${stale_pids[@]}"; do
  kill -KILL "$pid" >/dev/null 2>&1 || true
done
sleep 3

MODEL_CMD=(
  "$MODEL_BIN"
  --model "$MODEL_PATH"
  --alias "$MODEL_ALIAS"
  --host 0.0.0.0
  --port "$MODEL_PORT"
  --api-key-file "$API_KEY_FILE"
  -ngl all
  --ctx-size "$MODEL_CONTEXT_SIZE"
  --parallel "$MODEL_PARALLEL"
  --cont-batching
  --flash-attn on
  --batch-size "$MODEL_BATCH_SIZE"
  --ubatch-size "$MODEL_UBATCH_SIZE"
  --no-webui
)

for ((attempt=1; attempt<=MODEL_RECOVERY_ATTEMPTS; attempt+=1)); do
  printf '\n=== %s recovery attempt %d/%d parallel=%s ===\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$attempt" "$MODEL_RECOVERY_ATTEMPTS" "$MODEL_PARALLEL" >>"$RECOVERY_LOG"
  nohup "${MODEL_CMD[@]}" </dev/null >>"$RECOVERY_LOG" 2>&1 &
  model_pid=$!
  printf '%s\n' "$model_pid" >"$PID_FILE"
  deadline=$((SECONDS + MODEL_BOOT_TIMEOUT_SECONDS))

  while true; do
    if health; then
      log "Qwen recovered on attempt ${attempt}; pid=${model_pid} parallel=${MODEL_PARALLEL}"
      start_worker
      health || fatal "Qwen became unhealthy after worker restart"
      log "recovery complete; Qwen and agent worker are healthy"
      exit 0
    fi
    if ! kill -0 "$model_pid" 2>/dev/null; then
      log "llama-server exited during recovery attempt ${attempt}"
      tail -n 80 "$RECOVERY_LOG" >&2 || true
      break
    fi
    (( SECONDS < deadline )) || {
      log "recovery attempt ${attempt} exceeded ${MODEL_BOOT_TIMEOUT_SECONDS}s"
      kill -TERM "$model_pid" >/dev/null 2>&1 || true
      sleep 2
      kill -KILL "$model_pid" >/dev/null 2>&1 || true
      break
    }
    sleep 2
  done

  sleep $((attempt * 5))
done

fatal "Qwen recovery failed after ${MODEL_RECOVERY_ATTEMPTS} attempts; inspect ${RECOVERY_LOG}"