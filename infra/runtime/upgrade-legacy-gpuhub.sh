#!/usr/bin/env bash
set -Eeuo pipefail

log() { printf '[gpuhub-upgrade] %s\n' "$*"; }
fatal() { log "$*" >&2; exit 1; }

if [[ "${EUID}" -ne 0 ]]; then
  fatal "run as root on the GPUHub host"
fi

ROOT_DIR="${DIV3RSA_LEGACY_ROOT_DIR:-/root/autodl-tmp/localai}"
REPO_DIR="${DIV3RSA_LEGACY_APP_DIR:-${ROOT_DIR}/app}"
ENV_FILE="${DIV3RSA_LEGACY_ENV_FILE:-${ROOT_DIR}/secrets/gpuhub-worker.env}"
LOG_DIR="${DIV3RSA_LEGACY_LOG_DIR:-${ROOT_DIR}/logs}"
MODEL_PORT="${DIV3RSA_MODEL_PORT:-6006}"
SEARCH_PORT="${DIV3RSA_SEARCH_PORT:-8888}"
NODE_BIN="${DIV3RSA_LEGACY_NODE_BIN:-${ROOT_DIR}/runtime/node-current/bin/node}"
SCREEN_NAME="${DIV3RSA_LEGACY_WORKER_SCREEN:-localai-agent}"
TARGET_REF="${DIV3RSA_RUNTIME_GIT_REF:-main}"

[[ -d "$ROOT_DIR" ]] || fatal "legacy LocalAI root missing: $ROOT_DIR"
[[ -d "$REPO_DIR/.git" ]] || fatal "git checkout missing: $REPO_DIR"
[[ -f "$ENV_FILE" ]] || fatal "worker environment missing: $ENV_FILE"
mkdir -p "$LOG_DIR"

if [[ -n "$(git -C "$REPO_DIR" status --porcelain --untracked-files=no)" ]]; then
  fatal "tracked files are modified in $REPO_DIR; refusing destructive reset"
fi

log "capturing current runtime state"
date -u +'%Y-%m-%dT%H:%M:%SZ' >"$LOG_DIR/gpuhub-upgrade-last.txt"
printf 'before_commit=%s\n' "$(git -C "$REPO_DIR" rev-parse HEAD)" >>"$LOG_DIR/gpuhub-upgrade-last.txt"
pgrep -af 'llama-server|services/agent-worker/src/main.ts' >>"$LOG_DIR/gpuhub-upgrade-last.txt" || true

log "verifying existing Qwen server before changing worker code"
curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:${MODEL_PORT}/health" >/dev/null \
  || fatal "Qwen health check failed on 127.0.0.1:${MODEL_PORT}; upgrade aborted"

log "updating repository to origin/${TARGET_REF}"
git -C "$REPO_DIR" fetch --prune origin "$TARGET_REF"
git -C "$REPO_DIR" reset --hard FETCH_HEAD
git -C "$REPO_DIR" clean -fd
printf 'after_commit=%s\n' "$(git -C "$REPO_DIR" rev-parse HEAD)" >>"$LOG_DIR/gpuhub-upgrade-last.txt"

if [[ -x "$NODE_BIN" ]]; then
  export PATH="$(dirname "$NODE_BIN"):$PATH"
elif ! command -v node >/dev/null 2>&1; then
  fatal "Node.js is missing"
fi

log "installing locked production dependencies"
(cd "$REPO_DIR" && npm ci --omit=dev --ignore-scripts)

log "building and validating runtime skill manifest"
(cd "$REPO_DIR" && node scripts/build_skill_manifest.mjs)
(cd "$REPO_DIR" && node --experimental-transform-types --import ./infra/runpod/native-typescript-register.mjs scripts/smoke_native_ts_runtime.mjs)

ensure_container_runtime() {
  if command -v docker >/dev/null 2>&1 && (docker compose version >/dev/null 2>&1 || command -v docker-compose >/dev/null 2>&1); then
    return
  fi
  command -v apt-get >/dev/null 2>&1 || fatal "Docker/Compose missing and apt-get is unavailable"
  log "installing Ubuntu Docker + Compose packages for private SearXNG"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y --no-install-recommends docker.io docker-compose
  if command -v systemctl >/dev/null 2>&1; then
    systemctl enable --now docker
  else
    service docker start
  fi
  docker version >/dev/null 2>&1 || fatal "Docker daemon did not become available"
}

ensure_env_value() {
  local key="$1" value="$2"
  python3 - "$ENV_FILE" "$key" "$value" <<'PY'
from pathlib import Path
import re, sys
path = Path(sys.argv[1])
key, value = sys.argv[2], sys.argv[3]
text = path.read_text(encoding="utf-8")
pattern = re.compile(rf"^(?:export\s+)?{re.escape(key)}=.*$", re.M)
line = f"export {key}={value}"
if pattern.search(text):
    text = pattern.sub(line, text)
else:
    if text and not text.endswith("\n"):
        text += "\n"
    text += line + "\n"
path.write_text(text, encoding="utf-8")
PY
  chmod 600 "$ENV_FILE"
}

ensure_container_runtime
log "provisioning private SearXNG sidecar"
DIV3RSA_REPO_DIR="$REPO_DIR" \
DIV3RSA_RUNTIME_STATE_DIR="${ROOT_DIR}/secrets" \
DIV3RSA_SEARCH_PORT="$SEARCH_PORT" \
  bash "$REPO_DIR/infra/runtime/provision-search.sh" >/tmp/div3rsa-search-provision.out
ensure_env_value DIV3RSA_SEARCH_BASE_URL "http://127.0.0.1:${SEARCH_PORT}"
ensure_env_value DIV3RSA_INFERENCE_BASE_URL "http://127.0.0.1:${MODEL_PORT}/v1"
ensure_env_value QWEN_INFERENCE_BASE_URL "http://127.0.0.1:${MODEL_PORT}/v1"
ensure_env_value DIV3RSA_REPO_DIR "$REPO_DIR"
ensure_env_value DIV3RSA_REPOSITORY_ROOT "$REPO_DIR"

if [[ -z "${DIV3RSA_MODEL_PARALLEL:-}" ]]; then
  current_parallel="$(pgrep -af 'llama-server' | sed -nE 's/.*--parallel[= ]+([0-9]+).*/\1/p' | head -n1)"
  [[ -n "$current_parallel" ]] && ensure_env_value DIV3RSA_MODEL_PARALLEL "$current_parallel"
fi

log "restarting only the agent worker; Qwen inference remains running"
if command -v screen >/dev/null 2>&1; then
  screen -S "$SCREEN_NAME" -X quit >/dev/null 2>&1 || true
else
  fatal "screen is required by the legacy GPUHub runtime"
fi

screen -dmS "$SCREEN_NAME" bash -lc "
  set -Eeuo pipefail
  export PATH='$(dirname "$NODE_BIN")':\$PATH
  set -a
  source '$ENV_FILE'
  set +a
  cd '$REPO_DIR'
  exec node --experimental-transform-types --import ./infra/runpod/native-typescript-register.mjs services/agent-worker/src/main.ts >>'$LOG_DIR/agent-worker.log' 2>&1
"

sleep 3
screen -list | grep -F ".${SCREEN_NAME}" >/dev/null || fatal "agent worker screen did not stay running"
curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:${SEARCH_PORT}/search?q=div3rsa-health&format=json" >/dev/null \
  || fatal "SearXNG health check failed after worker restart"
curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:${MODEL_PORT}/health" >/dev/null \
  || fatal "Qwen health check failed after worker restart"

log "upgrade complete"
log "commit=$(git -C "$REPO_DIR" rev-parse HEAD)"
log "Qwen healthy on 127.0.0.1:${MODEL_PORT}; SearXNG healthy on 127.0.0.1:${SEARCH_PORT}; worker screen=${SCREEN_NAME}"
