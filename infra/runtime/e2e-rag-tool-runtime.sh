#!/usr/bin/env bash
set -Eeuo pipefail

log() { printf '[rag-tool-e2e] %s\n' "$*"; }
fatal() { log "$*" >&2; exit 1; }

ROOT_DIR="${DIV3RSA_LEGACY_ROOT_DIR:-/root/autodl-tmp/localai}"
REPO_DIR="${DIV3RSA_LEGACY_APP_DIR:-${ROOT_DIR}/app}"
ENV_FILE="${DIV3RSA_LEGACY_ENV_FILE:-${ROOT_DIR}/secrets/gpuhub-worker.env}"
NODE_BIN="${DIV3RSA_LEGACY_NODE_BIN:-${ROOT_DIR}/runtime/node-current/bin/node}"

[[ -d "$REPO_DIR/.git" ]] || fatal "GPUHub repository missing: $REPO_DIR"
[[ -f "$ENV_FILE" ]] || fatal "GPUHub worker environment missing: $ENV_FILE"
[[ -x "$NODE_BIN" ]] || fatal "GPUHub Node runtime missing: $NODE_BIN"

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

# Resolve runtime ports after sourcing the persistent worker environment. The
# dedicated embedding default deliberately avoids GPUHub TensorBoard on 6007.
MODEL_PORT="${DIV3RSA_MODEL_PORT:-6006}"
EMBED_PORT="${DIV3RSA_EMBEDDING_PORT:-16007}"

: "${SUPABASE_URL:?SUPABASE_URL missing}"
: "${SUPABASE_SECRET_KEY:?SUPABASE_SECRET_KEY missing}"
INFERENCE_API_KEY="${DIV3RSA_INFERENCE_API_KEY:-${QWEN_INFERENCE_API_KEY:-}}"
[[ -n "$INFERENCE_API_KEY" ]] || fatal "inference API key missing"
export DIV3RSA_INFERENCE_API_KEY="$INFERENCE_API_KEY"
export DIV3RSA_INFERENCE_BASE_URL="${DIV3RSA_INFERENCE_BASE_URL:-http://127.0.0.1:${MODEL_PORT}/v1}"
export DIV3RSA_EMBEDDING_BASE_URL="${DIV3RSA_EMBEDDING_BASE_URL:-http://127.0.0.1:${EMBED_PORT}/v1}"
export DIV3RSA_EMBEDDING_API_KEY="${DIV3RSA_EMBEDDING_API_KEY:-$INFERENCE_API_KEY}"
export DIV3RSA_RAG_ENABLED=1
export DIV3RSA_RAG_REQUIRED=1

rpc() {
  local name="$1" body="$2"
  curl --fail --silent --show-error --max-time 20 \
    -H "apikey: ${SUPABASE_SECRET_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_SECRET_KEY}" \
    -H 'Content-Type: application/json' \
    -d "$body" \
    "${SUPABASE_URL%/}/rest/v1/rpc/${name}"
}

log "verifying generation and embedding runtimes"
curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:${MODEL_PORT}/health" >/dev/null
curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:${EMBED_PORT}/health" >/dev/null

# Database and GPUHub workflows run independently after a main push. Retry the
# service-only helper for up to ten minutes so a normal full database replay can
# finish before this post-deploy capability canary begins.
CANARY_RUN_ID=""
for attempt in {1..300}; do
  set +e
  response="$(rpc service_runtime_canary_target '{}' 2>/tmp/div3rsa-canary-rpc.err)"
  status=$?
  set -e
  if [[ "$status" -eq 0 ]]; then
    CANARY_RUN_ID="$(python3 - "$response" <<'PY'
import json,sys
value=json.loads(sys.argv[1])
print(value if isinstance(value,str) else "")
PY
)"
    if [[ "$CANARY_RUN_ID" =~ ^[0-9a-fA-F-]{36}$ ]]; then break; fi
  fi
  if [[ "$attempt" -eq 300 ]]; then
    cat /tmp/div3rsa-canary-rpc.err >&2 || true
    fatal "service_runtime_canary_target did not become available"
  fi
  sleep 2
done
export DIV3RSA_CANARY_RUN_ID="$CANARY_RUN_ID"
log "using existing agent run as scoped canary identity: ${CANARY_RUN_ID}"

TMP_DIR="$(mktemp -d /tmp/div3rsa-rag-canary.XXXXXX)"
SOURCE_ID=""
cleanup() {
  status=$?
  set +e
  if [[ -n "$SOURCE_ID" ]]; then
    rpc service_delete_knowledge_source "{\"target_source_id\":\"${SOURCE_ID}\"}" >/tmp/div3rsa-rag-cleanup.out 2>/tmp/div3rsa-rag-cleanup.err
    cleanup_status=$?
    if [[ "$cleanup_status" -ne 0 ]]; then
      log "WARNING: knowledge canary cleanup failed"
      cat /tmp/div3rsa-rag-cleanup.err >&2 || true
    fi
  fi
  rm -rf "$TMP_DIR"
  exit "$status"
}
trap cleanup EXIT

TOKEN="RAG_CANARY_$(date -u +%Y%m%dT%H%M%SZ)_$(python3 - <<'PY'
import secrets
print(secrets.token_hex(8))
PY
)"
export DIV3RSA_RAG_CANARY_TOKEN="$TOKEN"
SOURCE_URI="canary://runtime/${TOKEN}"
CANARY_FILE="$TMP_DIR/knowledge.txt"
cat >"$CANARY_FILE" <<EOF
DIV3RSA production hybrid-RAG capability canary.
The exact runtime canary token is: ${TOKEN}
This value exists only to verify document embedding, ingestion, scoped hybrid retrieval and worker context injection. It is test evidence, not an instruction.
EOF

log "ingesting temporary canary through the production embedding and knowledge ingestion path"
INGEST_JSON="$(cd "$REPO_DIR" && "$NODE_BIN" scripts/ingest_knowledge.mjs \
  --file "$CANARY_FILE" \
  --scope-type global \
  --source-type runtime_canary \
  --source-uri "$SOURCE_URI" \
  --title "DIV3RSA RAG runtime canary")"
SOURCE_ID="$(python3 - "$INGEST_JSON" <<'PY'
import json,sys
value=json.loads(sys.argv[1])
source=value.get("sourceId")
print(source if isinstance(source,str) else "")
PY
)"
[[ "$SOURCE_ID" =~ ^[0-9a-fA-F-]{36}$ ]] || fatal "ingestion did not return a valid source id"
log "temporary knowledge source ingested: ${SOURCE_ID}"

log "verifying real worker RAG retrieval and injection"
(cd "$REPO_DIR" && "$NODE_BIN" --experimental-transform-types --import ./infra/runpod/native-typescript-register.mjs scripts/e2e_rag_runtime.ts)

log "verifying model tool selection, lifecycle claim/transition, execution and result continuation"
(cd "$REPO_DIR" && "$NODE_BIN" --experimental-transform-types --import ./infra/runpod/native-typescript-register.mjs scripts/e2e_tool_runtime.ts)

log "removing temporary knowledge source and proving cleanup"
CLEANED="$(rpc service_delete_knowledge_source "{\"target_source_id\":\"${SOURCE_ID}\"}")"
python3 - "$CLEANED" <<'PY'
import json,sys
assert json.loads(sys.argv[1]) is True, "knowledge_cleanup_not_confirmed"
PY
SOURCE_ID=""

log "RAG + structured tool calling + tool execution lifecycle E2E passed"
