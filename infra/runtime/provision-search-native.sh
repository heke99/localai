#!/usr/bin/env bash
set -Eeuo pipefail

log() { printf '[search-native] %s\n' "$*"; }
fatal() { log "$*" >&2; exit 1; }

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SEARCH_CAPABILITY_CHECK="${SCRIPT_DIR}/check-search-capability.sh"
ROOT_DIR="${DIV3RSA_LEGACY_ROOT_DIR:-/root/autodl-tmp/localai}"
SEARCH_ROOT="${DIV3RSA_NATIVE_SEARCH_ROOT:-${ROOT_DIR}/search}"
SRC_DIR="${SEARCH_ROOT}/searxng-src"
VENV_DIR="${SEARCH_ROOT}/venv"
STATE_DIR="${DIV3RSA_RUNTIME_STATE_DIR:-${ROOT_DIR}/secrets}"
SETTINGS_FILE="${DIV3RSA_SEARCH_SETTINGS_FILE:-${STATE_DIR}/searxng-settings.yml}"
SECRET_FILE="${DIV3RSA_SEARCH_SECRET_FILE:-${STATE_DIR}/searxng.secret}"
LOG_DIR="${DIV3RSA_LEGACY_LOG_DIR:-${ROOT_DIR}/logs}"
SEARCH_PORT="${DIV3RSA_SEARCH_PORT:-8890}"
SCREEN_NAME="${DIV3RSA_NATIVE_SEARCH_SCREEN:-localai-search}"
SEARXNG_REVISION="${DIV3RSA_SEARXNG_REVISION:-9fea41204fdfa7a5cfa15b0ebd12904c520478ce}"
INSTALL_MARKER="${VENV_DIR}/.div3rsa-searxng-revision"

[[ "${EUID}" -eq 0 ]] || fatal "run as root on the GPUHub host"
[[ -f "$SEARCH_CAPABILITY_CHECK" ]] || fatal "search capability check missing: $SEARCH_CAPABILITY_CHECK"
command -v git >/dev/null 2>&1 || fatal "git is required"
command -v python3 >/dev/null 2>&1 || fatal "python3 is required"
command -v screen >/dev/null 2>&1 || fatal "screen is required"
command -v curl >/dev/null 2>&1 || fatal "curl is required"

mkdir -p "$SEARCH_ROOT" "$STATE_DIR" "$LOG_DIR"
chmod 700 "$STATE_DIR"

if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  log "ensuring native SearXNG build dependencies"
  apt-get update -y >/dev/null
  apt-get install -y --no-install-recommends \
    python3-dev python3-venv git build-essential \
    libxslt1-dev zlib1g-dev libffi-dev libssl-dev >/dev/null
fi

if [[ -d "$SRC_DIR/.git" ]]; then
  log "updating pinned SearXNG source"
  git -C "$SRC_DIR" fetch --prune origin "$SEARXNG_REVISION"
else
  log "cloning SearXNG source"
  rm -rf "$SRC_DIR"
  git clone --filter=blob:none https://github.com/searxng/searxng.git "$SRC_DIR"
  git -C "$SRC_DIR" fetch --prune origin "$SEARXNG_REVISION"
fi

git -C "$SRC_DIR" checkout --detach "$SEARXNG_REVISION"
git -C "$SRC_DIR" reset --hard "$SEARXNG_REVISION"
git -C "$SRC_DIR" clean -fd
resolved_revision="$(git -C "$SRC_DIR" rev-parse HEAD)"
[[ "$resolved_revision" == "$SEARXNG_REVISION" ]] || fatal "SearXNG revision mismatch: ${resolved_revision}"

if [[ ! -x "$VENV_DIR/bin/python" ]]; then
  log "creating SearXNG Python virtualenv"
  rm -rf "$VENV_DIR"
  python3 -m venv "$VENV_DIR"
fi

if [[ ! -f "$INSTALL_MARKER" || "$(cat "$INSTALL_MARKER" 2>/dev/null || true)" != "$SEARXNG_REVISION" ]]; then
  log "installing pinned SearXNG into virtualenv"
  "$VENV_DIR/bin/pip" install --disable-pip-version-check -U pip setuptools wheel >/dev/null
  "$VENV_DIR/bin/pip" install --disable-pip-version-check -U pyyaml msgspec typing-extensions pybind11 >/dev/null
  (
    cd "$SRC_DIR"
    "$VENV_DIR/bin/pip" install --disable-pip-version-check --use-pep517 --no-build-isolation -e . >/dev/null
  )
  printf '%s\n' "$SEARXNG_REVISION" >"$INSTALL_MARKER"
fi

if [[ ! -s "$SECRET_FILE" ]]; then
  umask 077
  "$VENV_DIR/bin/python" - <<'PY' >"$SECRET_FILE"
import secrets
print(secrets.token_hex(32))
PY
  chmod 600 "$SECRET_FILE"
fi
SEARXNG_SECRET="$(cat "$SECRET_FILE")"

cat >"$SETTINGS_FILE" <<'YAML'
use_default_settings: true

general:
  debug: false
  instance_name: "DIV3RSA Search"

search:
  safe_search: 0
  formats:
    - html
    - json

# GPUHub production probes on 2026-08-27 proved that the default general-web
# engines could all fail behind CAPTCHA/rate-limit/403 while SearXNG still
# returned HTTP 200 with an empty results array. Bing and Yahoo were verified
# from the same host to return real web results; Yahoo also returned official
# Skatteverket sources while both returned official Node.js sources. Keep the
# default engine catalog intact and explicitly activate this redundant pair.
engines:
  - name: bing
    disabled: false
  - name: yahoo
    disabled: false

server:
  bind_address: "127.0.0.1"
  limiter: false
  public_instance: false
  image_proxy: false
YAML
chmod 600 "$SETTINGS_FILE"

# Stop only our previous search process, then prove that the selected loopback
# port is actually free. This prevents a false-positive health check against a
# different service such as Jupyter.
screen -S "$SCREEN_NAME" -X quit >/dev/null 2>&1 || true
sleep 1
if ! "$VENV_DIR/bin/python" - "$SEARCH_PORT" <<'PY'
import socket, sys
port = int(sys.argv[1])
sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
try:
    sock.bind(("127.0.0.1", port))
finally:
    sock.close()
PY
then
  fatal "search port 127.0.0.1:${SEARCH_PORT} is already in use; choose another DIV3RSA_SEARCH_PORT"
fi

log "starting native SearXNG on 127.0.0.1:${SEARCH_PORT}"
screen -dmS "$SCREEN_NAME" bash -lc "
  set -Eeuo pipefail
  export SEARXNG_SETTINGS_PATH='$SETTINGS_FILE'
  export SEARXNG_SECRET='$SEARXNG_SECRET'
  export SEARXNG_BIND_ADDRESS='127.0.0.1'
  export SEARXNG_PORT='$SEARCH_PORT'
  cd '$SRC_DIR'
  exec '$VENV_DIR/bin/python' -m searx.webapp >>'$LOG_DIR/searxng.log' 2>&1
"

deadline=$((SECONDS + ${DIV3RSA_SEARCH_BOOT_TIMEOUT_SECONDS:-120}))
search_base_url="http://127.0.0.1:${SEARCH_PORT}"
while true; do
  if bash "$SEARCH_CAPABILITY_CHECK" "$search_base_url" >/dev/null 2>&1; then
    break
  fi
  if ! screen -list | grep -F ".${SCREEN_NAME}" >/dev/null 2>&1; then
    log "native SearXNG process exited; recent log lines follow"
    tail -n 120 "$LOG_DIR/searxng.log" 2>/dev/null || true
    exit 70
  fi
  if (( SECONDS >= deadline )); then
    log "native SearXNG did not become search-capable"
    bash "$SEARCH_CAPABILITY_CHECK" "$search_base_url" || true
    tail -n 120 "$LOG_DIR/searxng.log" 2>/dev/null || true
    exit 70
  fi
  sleep 2
done

log "native SearXNG search-capable at revision ${SEARXNG_REVISION}"
printf 'DIV3RSA_SEARCH_BASE_URL=http://127.0.0.1:%s\n' "$SEARCH_PORT"
