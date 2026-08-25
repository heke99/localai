#!/usr/bin/env bash
set -Eeuo pipefail

log() {
  printf '[runpod-start] %s\n' "$*"
}

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    log "missing required environment: ${name}"
    exit 64
  fi
}

REPO_DIR="${DIV3RSA_REPO_DIR:-/workspace/localai-app}"
LLAMA_SERVER_BIN="${DIV3RSA_LLAMA_SERVER_BIN:-/workspace/localai/llama.cpp/build/bin/llama-server}"
MODEL_PATH="${DIV3RSA_MODEL_PATH:-/workspace/localai/models/qwen38-v3-q8/Qwen3.8-27B-OBLITERATED-Q8_0.gguf}"
MODEL_ALIAS="${DIV3RSA_MODEL_RUNTIME_ALIAS:-localai-qwen38-v3-q8}"
MODEL_PORT="${DIV3RSA_MODEL_PORT:-8080}"
MODEL_CONTEXT_SIZE="${DIV3RSA_MODEL_CONTEXT_SIZE:-32768}"
MODEL_BATCH_SIZE="${DIV3RSA_MODEL_BATCH_SIZE:-2048}"
MODEL_PARALLEL="${DIV3RSA_MODEL_PARALLEL:-4}"
MODEL_BOOT_TIMEOUT_SECONDS="${DIV3RSA_MODEL_BOOT_TIMEOUT_SECONDS:-900}"
LOG_DIR="${DIV3RSA_RUNPOD_LOG_DIR:-/workspace/logs/div3rsa}"

require_env SUPABASE_URL
require_env SUPABASE_SECRET_KEY
require_env QWEN_INFERENCE_API_KEY

if [[ ! -d "$REPO_DIR/.git" ]]; then
  log "repository not found at ${REPO_DIR}; set DIV3RSA_REPO_DIR to the persistent LocalAI checkout"
  exit 66
fi
if [[ ! -x "$LLAMA_SERVER_BIN" ]]; then
  log "llama-server is not executable at ${LLAMA_SERVER_BIN}"
  exit 66
fi
if [[ ! -f "$MODEL_PATH" ]]; then
  log "verified model artifact not found at ${MODEL_PATH}"
  exit 66
fi
if ! command -v node >/dev/null 2>&1; then
  log "Node.js is required for the agent worker"
  exit 69
fi
if ! command -v curl >/dev/null 2>&1; then
  log "curl is required for the local model health check"
  exit 69
fi
if [[ ! -d "$REPO_DIR/node_modules" ]]; then
  if [[ "${DIV3RSA_INSTALL_NODE_DEPS_ON_BOOT:-0}" == "1" ]]; then
    log "node_modules missing; installing pinned production dependencies"
    (cd "$REPO_DIR" && npm ci --omit=dev --ignore-scripts)
  else
    log "node_modules missing in ${REPO_DIR}; install dependencies once or set DIV3RSA_INSTALL_NODE_DEPS_ON_BOOT=1"
    exit 69
  fi
fi

mkdir -p "$LOG_DIR"

BASE_PID=""
MODEL_PID=""
WORKER_PID=""

shutdown() {
  local status="${1:-0}"
  trap - TERM INT EXIT
  log "stopping LocalAI runtime"
  for pid in "$WORKER_PID" "$MODEL_PID" "$BASE_PID"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill -TERM "$pid" 2>/dev/null || true
    fi
  done
  wait 2>/dev/null || true
  exit "$status"
}
trap 'shutdown 143' TERM
trap 'shutdown 130' INT
trap 'shutdown $?' EXIT

if [[ "${DIV3RSA_START_RUNPOD_BASE_SERVICES:-1}" == "1" && -x /start.sh ]]; then
  log "starting RunPod base services"
  /start.sh >>"$LOG_DIR/runpod-base.log" 2>&1 &
  BASE_PID=$!
fi

log "starting Qwen V3 Q8 inference on 0.0.0.0:${MODEL_PORT}"
"$LLAMA_SERVER_BIN" \
  --model "$MODEL_PATH" \
  --alias "$MODEL_ALIAS" \
  --host 0.0.0.0 \
  --port "$MODEL_PORT" \
  --ctx-size "$MODEL_CONTEXT_SIZE" \
  --batch-size "$MODEL_BATCH_SIZE" \
  --parallel "$MODEL_PARALLEL" \
  --n-gpu-layers 999 \
  --metrics \
  --jinja \
  --api-key "$QWEN_INFERENCE_API_KEY" \
  >>"$LOG_DIR/llama-server.log" 2>&1 &
MODEL_PID=$!

health_url="http://127.0.0.1:${MODEL_PORT}/health"
deadline=$((SECONDS + MODEL_BOOT_TIMEOUT_SECONDS))
while true; do
  if ! kill -0 "$MODEL_PID" 2>/dev/null; then
    log "llama-server exited during startup; inspect ${LOG_DIR}/llama-server.log"
    exit 70
  fi
  if curl --fail --silent --show-error --max-time 5 "$health_url" >/dev/null 2>&1; then
    break
  fi
  if (( SECONDS >= deadline )); then
    log "model did not become healthy within ${MODEL_BOOT_TIMEOUT_SECONDS}s"
    exit 70
  fi
  sleep 5
done
log "model healthy"

export QWEN_INFERENCE_BASE_URL="http://127.0.0.1:${MODEL_PORT}/v1"
export DIV3RSA_REPOSITORY_ROOT="$REPO_DIR"
export DIV3RSA_WORKER_ID="${DIV3RSA_WORKER_ID:-agent-worker-${RUNPOD_POD_ID:-runpod}}"
export DIV3RSA_MODEL_STARTUP_TIMEOUT_MS="${DIV3RSA_MODEL_STARTUP_TIMEOUT_MS:-900000}"
export DIV3RSA_MODEL_STARTUP_POLL_MS="${DIV3RSA_MODEL_STARTUP_POLL_MS:-5000}"

log "starting agent queue worker ${DIV3RSA_WORKER_ID}"
(
  cd "$REPO_DIR"
  exec node --experimental-strip-types services/agent-worker/src/main.ts
) >>"$LOG_DIR/agent-worker.log" 2>&1 &
WORKER_PID=$!

while true; do
  if ! kill -0 "$MODEL_PID" 2>/dev/null; then
    wait "$MODEL_PID" || status=$?
    log "llama-server stopped unexpectedly"
    exit "${status:-1}"
  fi
  if ! kill -0 "$WORKER_PID" 2>/dev/null; then
    wait "$WORKER_PID" || status=$?
    log "agent worker stopped unexpectedly"
    exit "${status:-1}"
  fi
  sleep 5
done
