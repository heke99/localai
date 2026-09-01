#!/usr/bin/env bash
set -Eeuo pipefail

log() { printf '[embedding-runtime] %s\n' "$*"; }
fatal() { log "$*" >&2; exit 1; }

ROOT_DIR="${DIV3RSA_LEGACY_ROOT_DIR:-/root/autodl-tmp/localai}"
REPO_DIR="${DIV3RSA_LEGACY_APP_DIR:-${ROOT_DIR}/app}"
MODEL_BIN="${DIV3RSA_LLAMA_SERVER_BIN:-${ROOT_DIR}/runtime/llama.cpp/build/bin/llama-server}"
API_KEY_FILE="${DIV3RSA_INFERENCE_API_KEY_FILE:-${ROOT_DIR}/secrets/inference-api-key}"
EMBED_PORT="${DIV3RSA_EMBEDDING_PORT:-6007}"
EMBED_MODEL_DIR="${DIV3RSA_EMBEDDING_MODEL_DIR:-${ROOT_DIR}/models/embeddings/qwen3-embedding-0.6b}"
EMBED_MODEL_PATH="${DIV3RSA_EMBEDDING_MODEL_PATH:-${EMBED_MODEL_DIR}/Qwen3-Embedding-0.6B-Q8_0.gguf}"
EMBED_ALIAS="${DIV3RSA_EMBEDDING_RUNTIME_ALIAS:-qwen3-embedding-0.6b-q8_0-d20cf9c}"
LOG_DIR="${DIV3RSA_LEGACY_LOG_DIR:-${ROOT_DIR}/logs}"
PID_FILE="${ROOT_DIR}/runtime/qwen-embedding.pid"
EXPECTED_SHA="06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439"
EXPECTED_BYTES="639150592"

[[ -x "$MODEL_BIN" ]] || fatal "llama-server missing: $MODEL_BIN"
[[ -r "$API_KEY_FILE" ]] || fatal "inference api key file missing: $API_KEY_FILE"
mkdir -p "$EMBED_MODEL_DIR" "$LOG_DIR" "$(dirname "$PID_FILE")"

verify_model() {
  [[ -f "$EMBED_MODEL_PATH" ]] || return 1
  [[ "$(wc -c <"$EMBED_MODEL_PATH" | tr -d ' ')" == "$EXPECTED_BYTES" ]] || return 1
  [[ "$(sha256sum "$EMBED_MODEL_PATH" | cut -d ' ' -f 1)" == "$EXPECTED_SHA" ]]
}

if ! verify_model; then
  log "fetching pinned Qwen3-Embedding Q8 model"
  rm -f "$EMBED_MODEL_PATH"
  DIV3RSA_EMBEDDING_MODEL_DIR="$EMBED_MODEL_DIR" bash "$REPO_DIR/scripts/fetch_qwen3_embedding_q8.sh"
  verify_model || fatal "embedding model verification failed after fetch"
fi

health() {
  curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:${EMBED_PORT}/health" >/dev/null 2>&1
}

probe() {
  local api_key
  api_key="$(cat "$API_KEY_FILE")"
  curl --fail --silent --show-error --max-time 20 \
    -H "Authorization: Bearer ${api_key}" \
    -H 'Content-Type: application/json' \
    -d "{\"model\":\"${EMBED_ALIAS}\",\"input\":\"DIV3RSA embedding health probe\",\"encoding_format\":\"float\"}" \
    "http://127.0.0.1:${EMBED_PORT}/v1/embeddings" \
    | python3 -c 'import json,sys; d=json.load(sys.stdin); e=d["data"][0]["embedding"]; assert len(e)==1024; assert all(isinstance(x,(int,float)) for x in e)'
}

if health && probe; then
  log "embedding runtime healthy on 127.0.0.1:${EMBED_PORT}"
  exit 0
fi

mapfile -t stale_pids < <(pgrep -f 'llama-server.*Qwen3-Embedding-0\.6B-Q8_0\.gguf' || true)
for pid in "${stale_pids[@]}"; do kill -TERM "$pid" >/dev/null 2>&1 || true; done
sleep 2
mapfile -t stale_pids < <(pgrep -f 'llama-server.*Qwen3-Embedding-0\.6B-Q8_0\.gguf' || true)
for pid in "${stale_pids[@]}"; do kill -KILL "$pid" >/dev/null 2>&1 || true; done

nohup "$MODEL_BIN" \
  --model "$EMBED_MODEL_PATH" \
  --alias "$EMBED_ALIAS" \
  --host 127.0.0.1 \
  --port "$EMBED_PORT" \
  --api-key-file "$API_KEY_FILE" \
  -ngl all \
  --ctx-size 8192 \
  --parallel 1 \
  --embedding \
  --pooling last \
  --batch-size 2048 \
  --ubatch-size 512 \
  --no-webui \
  </dev/null >>"$LOG_DIR/embedding-runtime.log" 2>&1 &
printf '%s\n' "$!" >"$PID_FILE"

for _ in {1..180}; do
  if health && probe; then
    log "embedding runtime ready; model=${EMBED_ALIAS}; dimensions=1024"
    exit 0
  fi
  if ! kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    tail -n 80 "$LOG_DIR/embedding-runtime.log" >&2 || true
    fatal "embedding llama-server exited during startup"
  fi
  sleep 2
done

fatal "embedding runtime failed to become healthy"
