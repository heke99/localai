#!/usr/bin/env bash
set -Eeuo pipefail

log() {
  printf '[runtime-start] %s\n' "$*"
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
LOG_DIR="${DIV3RSA_RUNTIME_LOG_DIR:-${DIV3RSA_RUNPOD_LOG_DIR:-/workspace/logs/div3rsa}}"
WORKER_MAX_RESTARTS="${DIV3RSA_WORKER_MAX_RESTARTS:-5}"
WORKER_RESTART_WINDOW_SECONDS="${DIV3RSA_WORKER_RESTART_WINDOW_SECONDS:-300}"
INFERENCE_API_KEY="${DIV3RSA_INFERENCE_API_KEY:-${QWEN_INFERENCE_API_KEY:-}}"
START_PROVIDER_BASE_SERVICES="${DIV3RSA_START_PROVIDER_BASE_SERVICES:-${DIV3RSA_START_RUNPOD_BASE_SERVICES:-0}}"
RUNTIME_EXTERNAL_ID="${DIV3RSA_RUNTIME_EXTERNAL_ID:-${RUNPOD_POD_ID:-runtime}}"

require_env SUPABASE_URL
require_env SUPABASE_SECRET_KEY
if [[ -z "$INFERENCE_API_KEY" ]]; then
  log "missing required environment: DIV3RSA_INFERENCE_API_KEY (legacy QWEN_INFERENCE_API_KEY is also accepted)"
  exit 64
fi

if [[ ! -d "$REPO_DIR/.git" ]]; then
  log "repository not found at ${REPO_DIR}; set DIV3RSA_REPO_DIR to the runtime checkout"
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
RUN_STARTED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
printf '\n=== %s runtime start ===\n' "$RUN_STARTED_AT" >>"$LOG_DIR/llama-server.log"
printf '\n=== %s runtime start ===\n' "$RUN_STARTED_AT" >>"$LOG_DIR/agent-worker.log"

log "building runtime skill manifest"
if ! (
  cd "$REPO_DIR"
  node scripts/build_skill_manifest.mjs
) >>"$LOG_DIR/agent-worker.log" 2>&1; then
  log "skill manifest build failed; inspect ${LOG_DIR}/agent-worker.log"
  exit 69
fi

log "validating native TypeScript agent runtime"
if ! (
  cd "$REPO_DIR"
  node --experimental-transform-types \
    --import ./infra/runpod/native-typescript-register.mjs \
    scripts/smoke_native_ts_runtime.mjs
) >>"$LOG_DIR/agent-worker.log" 2>&1; then
  log "agent runtime module preflight failed; inspect ${LOG_DIR}/agent-worker.log"
  exit 69
fi
log "agent runtime module preflight healthy"

# Existing externally managed search endpoints win. Otherwise the runtime starts
# a private loopback SearXNG sidecar when a container runtime exists. The sidecar
# generates and persists its own secret locally; no operator-managed search secret
# is required on raw GPU hosts.
if [[ -z "${DIV3RSA_SEARCH_BASE_URL:-}" ]]; then
  SEARCH_AUTOSTART="${DIV3RSA_SEARCH_AUTOSTART:-auto}"
  SEARCH_CONTAINER_AVAILABLE=0
  if command -v docker >/dev/null 2>&1 && (docker compose version >/dev/null 2>&1 || command -v docker-compose >/dev/null 2>&1); then
    SEARCH_CONTAINER_AVAILABLE=1
  fi
  if [[ "$SEARCH_AUTOSTART" == "1" || "$SEARCH_AUTOSTART" == "true" || ( "$SEARCH_AUTOSTART" == "auto" && "$SEARCH_CONTAINER_AVAILABLE" == "1" ) ]]; then
    if [[ "$SEARCH_CONTAINER_AVAILABLE" != "1" ]]; then
      log "private search autostart requested but Docker Compose is unavailable"
      exit 69
    fi
    if ! bash "$REPO_DIR/infra/runtime/provision-search.sh" >>"$LOG_DIR/agent-worker.log" 2>&1; then
      log "private search runtime failed to start; inspect ${LOG_DIR}/agent-worker.log"
      exit 70
    fi
    export DIV3RSA_SEARCH_BASE_URL="http://127.0.0.1:${DIV3RSA_SEARCH_PORT:-8888}"
    log "private search runtime healthy on 127.0.0.1:${DIV3RSA_SEARCH_PORT:-8888}"
  else
    log "search runtime disabled because no external search URL or container runtime is available"
  fi
fi

check_model_port_available() {
  DIV3RSA_CHECK_PORT="$MODEL_PORT" node --input-type=module -e '
    import net from "node:net";
    const port = Number(process.env.DIV3RSA_CHECK_PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) process.exit(64);
    const server = net.createServer();
    server.once("error", () => process.exit(1));
    server.listen({ host: "0.0.0.0", port, exclusive: true }, () => {
      server.close((error) => process.exit(error ? 1 : 0));
    });
  ' >/dev/null 2>&1
}

BASE_PID=""
MODEL_PID=""
WORKER_PID=""
WORKER_RESTARTS=0
WORKER_RESTART_WINDOW_STARTED=$SECONDS

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

if [[ "$START_PROVIDER_BASE_SERVICES" == "1" && -x /start.sh ]]; then
  log "starting provider base services"
  /start.sh >>"$LOG_DIR/provider-base.log" 2>&1 &
  BASE_PID=$!
fi

if ! check_model_port_available; then
  log "model port ${MODEL_PORT} is already in use; stop the existing listener or set DIV3RSA_MODEL_PORT"
  exit 70
fi

log "starting Qwen V3 Q8 inference on 0.0.0.0:${MODEL_PORT} (ctx=${MODEL_CONTEXT_SIZE}, batch=${MODEL_BATCH_SIZE}, parallel=${MODEL_PARALLEL})"
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
  --api-key "$INFERENCE_API_KEY" \
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

# Every provider runs the exact same local inference contract. Physical public
# endpoints are control-plane metadata and never become the worker's identity.
export DIV3RSA_INFERENCE_BASE_URL="http://127.0.0.1:${MODEL_PORT}/v1"
export DIV3RSA_INFERENCE_API_KEY="$INFERENCE_API_KEY"
export QWEN_INFERENCE_BASE_URL="$DIV3RSA_INFERENCE_BASE_URL"
export QWEN_INFERENCE_API_KEY="$INFERENCE_API_KEY"
export DIV3RSA_REPOSITORY_ROOT="$REPO_DIR"
export DIV3RSA_MODEL_PARALLEL="$MODEL_PARALLEL"
export DIV3RSA_WORKER_ID="${DIV3RSA_WORKER_ID:-agent-worker-${RUNTIME_EXTERNAL_ID}}"
export DIV3RSA_MODEL_STARTUP_TIMEOUT_MS="${DIV3RSA_MODEL_STARTUP_TIMEOUT_MS:-900000}"
export DIV3RSA_MODEL_STARTUP_POLL_MS="${DIV3RSA_MODEL_STARTUP_POLL_MS:-5000}"
export DIV3RSA_QUEUE_IDLE_POLL_MS="${DIV3RSA_QUEUE_IDLE_POLL_MS:-200}"
export DIV3RSA_QUEUE_ERROR_BACKOFF_MS="${DIV3RSA_QUEUE_ERROR_BACKOFF_MS:-1000}"

start_worker() {
  log "starting agent queue worker ${DIV3RSA_WORKER_ID}"
  (
    cd "$REPO_DIR"
    exec node --experimental-transform-types \
      --import ./infra/runpod/native-typescript-register.mjs \
      services/agent-worker/src/main.ts
  ) >>"$LOG_DIR/agent-worker.log" 2>&1 &
  WORKER_PID=$!
}

start_worker

while true; do
  if ! kill -0 "$MODEL_PID" 2>/dev/null; then
    status=0
    wait "$MODEL_PID" || status=$?
    if (( status == 0 )); then status=1; fi
    log "llama-server stopped unexpectedly (exit=${status}); inspect ${LOG_DIR}/llama-server.log"
    exit "$status"
  fi
  if ! kill -0 "$WORKER_PID" 2>/dev/null; then
    status=0
    wait "$WORKER_PID" || status=$?
    if (( status == 0 )); then status=1; fi

    if (( SECONDS - WORKER_RESTART_WINDOW_STARTED > WORKER_RESTART_WINDOW_SECONDS )); then
      WORKER_RESTARTS=0
      WORKER_RESTART_WINDOW_STARTED=$SECONDS
    fi
    WORKER_RESTARTS=$((WORKER_RESTARTS + 1))

    if (( WORKER_RESTARTS > WORKER_MAX_RESTARTS )); then
      log "agent worker exceeded restart budget (${WORKER_MAX_RESTARTS} within ${WORKER_RESTART_WINDOW_SECONDS}s); last exit=${status}; inspect ${LOG_DIR}/agent-worker.log"
      exit "$status"
    fi

    log "agent worker stopped unexpectedly (exit=${status}); restarting ${WORKER_RESTARTS}/${WORKER_MAX_RESTARTS}; inspect ${LOG_DIR}/agent-worker.log"
    sleep 1
    start_worker
    continue
  fi
  sleep 2
done
