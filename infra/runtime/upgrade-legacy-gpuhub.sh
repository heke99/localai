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

if [[ -n "$(git -C "$REPO_DIR" status --porcelain)" ]]; then
  fatal "repository has uncommitted or untracked files in $REPO_DIR; refusing destructive reset"
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

docker_compose_available() {
  docker compose version >/dev/null 2>&1 || command -v docker-compose >/dev/null 2>&1
}

docker_daemon_ready() {
  docker info >/dev/null 2>&1
}

start_docker_without_systemd() {
  local data_root="${ROOT_DIR}/docker-data"
  local exec_root="${ROOT_DIR}/docker-exec"
  local pid_file="${ROOT_DIR}/docker.pid"
  local daemon_log="${LOG_DIR}/dockerd.log"
  mkdir -p "$data_root" "$exec_root"

  if pgrep -x dockerd >/dev/null 2>&1; then
    log "dockerd process already exists; waiting for daemon readiness"
  else
    log "starting dockerd directly because systemd is not PID 1"
    rm -f "$pid_file"
    nohup dockerd \
      --host=unix:///var/run/docker.sock \
      --data-root="$data_root" \
      --exec-root="$exec_root" \
      --pidfile="$pid_file" \
      >"$daemon_log" 2>&1 &
  fi

  local attempt
  for attempt in {1..45}; do
    if docker_daemon_ready; then
      log "Docker daemon is ready"
      return 0
    fi
    sleep 1
  done

  log "Docker daemon failed to become ready; last dockerd log lines follow"
  tail -n 120 "$daemon_log" 2>/dev/null || true
  return 1
}

ensure_container_runtime() {
  local needs_install=0
  command -v docker >/dev/null 2>&1 || needs_install=1
  if (( needs_install == 0 )) && ! docker_compose_available; then
    needs_install=1
  fi

  if (( needs_install == 1 )); then
    command -v apt-get >/dev/null 2>&1 || fatal "Docker/Compose missing and apt-get is unavailable"
    log "installing Ubuntu Docker + Compose packages for private SearXNG"
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y
    apt-get install -y --no-install-recommends docker.io docker-compose
  fi

  command -v docker >/dev/null 2>&1 || fatal "Docker CLI is still missing after installation"
  docker_compose_available || fatal "Docker Compose is still missing after installation"

  if docker_daemon_ready; then
    log "Docker daemon is already ready"
    return
  fi

  local pid1
  pid1="$(ps -p 1 -o comm= 2>/dev/null | tr -d '[:space:]' || true)"
  if [[ "$pid1" == "systemd" ]] && command -v systemctl >/dev/null 2>&1; then
    log "starting Docker through systemd"
    systemctl enable --now docker || true
  elif command -v service >/dev/null 2>&1; then
    log "trying legacy service startup for Docker"
    service docker start >/dev/null 2>&1 || true
  fi

  if docker_daemon_ready; then
    log "Docker daemon is ready"
    return
  fi

  start_docker_without_systemd || fatal "Docker daemon did not become available; see ${LOG_DIR}/dockerd.log"
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
