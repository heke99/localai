#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MANIFEST="${DIV3RSA_GPU_MANIFEST:-${ROOT}/infra/gpu/model-manifest.json}"
REPO_DIR="${DIV3RSA_REPO_DIR:-${ROOT}}"
LLAMA_SERVER_BIN="${DIV3RSA_LLAMA_SERVER_BIN:-/opt/div3rsa/llama.cpp/build/bin/llama-server}"
MODEL_DIR="${DIV3RSA_MODEL_DIR:-/opt/div3rsa/models/qwen3.8-27b-obliterated-v3}"
MODEL_PORT="${DIV3RSA_MODEL_PORT:-8080}"
MODEL_ALIAS="${DIV3RSA_MODEL_RUNTIME_ALIAS:-localai-qwen38-v3-q8}"
LOG_DIR="${DIV3RSA_RUNTIME_LOG_DIR:-/opt/div3rsa/logs}"
INFERENCE_API_KEY="${DIV3RSA_INFERENCE_API_KEY:-${QWEN_INFERENCE_API_KEY:-}}"

die() { printf '[inference-node] %s\n' "$*" >&2; exit 1; }
log() { printf '[inference-node] %s\n' "$*"; }

[[ -n "$INFERENCE_API_KEY" ]] || die "inference_api_key_required"
[[ -f "$MANIFEST" ]] || die "gpu_manifest_missing"
[[ -x "$LLAMA_SERVER_BIN" ]] || die "llama_server_missing:${LLAMA_SERVER_BIN}"
command -v python3 >/dev/null 2>&1 || die "python3_required"
command -v node >/dev/null 2>&1 || die "node_required_for_registrar"
command -v curl >/dev/null 2>&1 || die "curl_required"

readarray -t profile < <(python3 - "$MANIFEST" <<'PY'
import json,sys
m=json.load(open(sys.argv[1], encoding='utf-8'))
p=m['productionProfile']; model=m['model']
print(model['filename'])
print(p['parallel'])
print(p['totalContext'])
print(p['batchSize'])
print(p['ubatchSize'])
print(p['specType'])
PY
) || die "manifest_invalid"
MODEL_PATH="${DIV3RSA_MODEL_PATH:-${MODEL_DIR}/${profile[0]}}"
PARALLEL="${profile[1]}"
TOTAL_CONTEXT="${profile[2]}"
BATCH_SIZE="${profile[3]}"
UBATCH_SIZE="${profile[4]}"
SPEC_TYPE="${profile[5]}"
[[ -f "$MODEL_PATH" ]] || die "model_missing:${MODEL_PATH}"

export DIV3RSA_RUNTIME_ROLE=inference
export DIV3RSA_MODEL_PARALLEL="$PARALLEL"
export DIV3RSA_MODEL_CONTEXT_SIZE="$TOTAL_CONTEXT"
export DIV3RSA_INFERENCE_BASE_URL="http://127.0.0.1:${MODEL_PORT}/v1"
export QWEN_INFERENCE_BASE_URL="$DIV3RSA_INFERENCE_BASE_URL"
export DIV3RSA_INFERENCE_API_KEY="$INFERENCE_API_KEY"
export QWEN_INFERENCE_API_KEY="$INFERENCE_API_KEY"

mkdir -p "$LOG_DIR"
LLAMA_PID=""
REGISTRAR_PID=""

shutdown() {
  local status="${1:-0}"
  trap - TERM INT EXIT
  log "draining inference node"
  if [[ -n "$REGISTRAR_PID" ]] && kill -0 "$REGISTRAR_PID" 2>/dev/null; then
    kill -TERM "$REGISTRAR_PID" 2>/dev/null || true
    for _ in {1..20}; do
      kill -0 "$REGISTRAR_PID" 2>/dev/null || break
      sleep 0.1
    done
  fi
  if [[ -n "$LLAMA_PID" ]] && kill -0 "$LLAMA_PID" 2>/dev/null; then kill -TERM "$LLAMA_PID" 2>/dev/null || true; fi
  wait 2>/dev/null || true
  exit "$status"
}
trap 'shutdown 143' TERM
trap 'shutdown 130' INT
trap 'shutdown $?' EXIT

log "starting inference-only Qwen node port=${MODEL_PORT} parallel=${PARALLEL} total_ctx=${TOTAL_CONTEXT} spec=${SPEC_TYPE}"
"$LLAMA_SERVER_BIN" \
  --model "$MODEL_PATH" \
  --alias "$MODEL_ALIAS" \
  --host 0.0.0.0 \
  --port "$MODEL_PORT" \
  --api-key "$INFERENCE_API_KEY" \
  --n-gpu-layers 999 \
  --ctx-size "$TOTAL_CONTEXT" \
  --parallel "$PARALLEL" \
  --cont-batching \
  --flash-attn on \
  --batch-size "$BATCH_SIZE" \
  --ubatch-size "$UBATCH_SIZE" \
  --metrics \
  --jinja \
  --spec-type "$SPEC_TYPE" \
  --no-webui \
  >>"$LOG_DIR/llama-server.log" 2>&1 &
LLAMA_PID=$!

health_url="http://127.0.0.1:${MODEL_PORT}/health"
deadline=$((SECONDS + ${DIV3RSA_MODEL_BOOT_TIMEOUT_SECONDS:-900}))
while true; do
  kill -0 "$LLAMA_PID" 2>/dev/null || die "llama_server_exited_during_startup"
  if curl --fail --silent --max-time 5 "$health_url" >/dev/null 2>&1; then break; fi
  (( SECONDS < deadline )) || die "model_health_timeout"
  sleep 3
done

log "local model healthy; validating immutable node contract"
bash "$REPO_DIR/infra/gpu/verify-node.sh"

log "starting lightweight registrar; no agent queue worker will run on this GPU"
(
  cd "$REPO_DIR"
  exec node --experimental-transform-types \
    --import ./infra/runpod/native-typescript-register.mjs \
    services/agent-worker/src/inference-node-registrar.ts
) >>"$LOG_DIR/inference-registrar.log" 2>&1 &
REGISTRAR_PID=$!

while true; do
  if ! kill -0 "$LLAMA_PID" 2>/dev/null; then
    wait "$LLAMA_PID" || status=$?
    die "llama_server_stopped:${status:-1}"
  fi
  if ! kill -0 "$REGISTRAR_PID" 2>/dev/null; then
    wait "$REGISTRAR_PID" || status=$?
    die "inference_registrar_stopped:${status:-1}"
  fi
  sleep 2
done
