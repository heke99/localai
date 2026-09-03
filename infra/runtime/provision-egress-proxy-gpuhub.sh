#!/usr/bin/env bash
set -Eeuo pipefail

log() { printf '[gpuhub-egress] %s\n' "$*"; }
fatal() { log "$*" >&2; exit 1; }

[[ "${EUID}" -eq 0 ]] || fatal "run as root on GPUHub"

ROOT_DIR="${DIV3RSA_LEGACY_ROOT_DIR:-/root/autodl-tmp/localai}"
REPO_DIR="${DIV3RSA_LEGACY_APP_DIR:-${ROOT_DIR}/app}"
NODE_BIN="${DIV3RSA_LEGACY_NODE_BIN:-${ROOT_DIR}/runtime/node-current/bin/node}"
INSTALL_ROOT="${DIV3RSA_EGRESS_INSTALL_ROOT:-/opt/div3rsa/egress-proxy}"
LOG_DIR="${DIV3RSA_LEGACY_LOG_DIR:-${ROOT_DIR}/logs}"
LOG_FILE="${LOG_DIR}/egress-proxy.log"
SCREEN_NAME="${DIV3RSA_EGRESS_SCREEN_NAME:-localai-egress}"
LISTEN_HOST="127.0.0.1"
LISTEN_PORT="${DIV3RSA_EGRESS_PROXY_PORT:-7318}"
PROXY_URL="http://${LISTEN_HOST}:${LISTEN_PORT}"
SERVICE_USER="div3rsa-egress"

[[ -d "$REPO_DIR" ]] || fatal "repository missing: $REPO_DIR"
[[ -f "$REPO_DIR/services/egress-proxy/src/main.ts" ]] || fatal "egress proxy source missing"
[[ -f "$REPO_DIR/services/egress-proxy/src/policy.ts" ]] || fatal "egress proxy policy missing"
[[ -f "$REPO_DIR/infra/runpod/native-typescript-register.mjs" ]] || fatal "native TypeScript resolver missing"
if [[ ! -x "$NODE_BIN" ]]; then
  NODE_BIN="$(command -v node || true)"
fi
[[ -n "$NODE_BIN" && -x "$NODE_BIN" ]] || fatal "Node.js 24 runtime missing"
"$NODE_BIN" -e 'if(Number(process.versions.node.split(".")[0])<24)process.exit(1)' || fatal "Node.js >=24 is required"
for cmd in curl screen setpriv useradd; do command -v "$cmd" >/dev/null 2>&1 || fatal "$cmd is required"; done

if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$SERVICE_USER"
fi

mkdir -p "$LOG_DIR"
install -d -o root -g root -m 0755 "$INSTALL_ROOT"
install -o root -g root -m 0644 "$REPO_DIR/services/egress-proxy/src/main.ts" "$INSTALL_ROOT/main.ts"
install -o root -g root -m 0644 "$REPO_DIR/services/egress-proxy/src/policy.ts" "$INSTALL_ROOT/policy.ts"
install -o root -g root -m 0644 "$REPO_DIR/infra/runpod/native-typescript-register.mjs" "$INSTALL_ROOT/native-typescript-register.mjs"

cat >"$INSTALL_ROOT/run.sh" <<EOF
#!/usr/bin/env bash
set -Eeuo pipefail
export DIV3RSA_EGRESS_PROXY_HOST=${LISTEN_HOST}
export DIV3RSA_EGRESS_PROXY_PORT=${LISTEN_PORT}
cd ${INSTALL_ROOT}
exec ${NODE_BIN} --experimental-transform-types --import ${INSTALL_ROOT}/native-typescript-register.mjs ${INSTALL_ROOT}/main.ts
EOF
chmod 0755 "$INSTALL_ROOT/run.sh"
chown root:root "$INSTALL_ROOT/run.sh"

screen -S "$SCREEN_NAME" -X quit >/dev/null 2>&1 || true
sleep 0.5

if ! "$NODE_BIN" - "$LISTEN_PORT" <<'NODE'
const net = require("node:net");
const port = Number(process.argv[2]);
const server = net.createServer();
server.once("error", () => process.exit(1));
server.listen({ host: "127.0.0.1", port, exclusive: true }, () => server.close((error) => process.exit(error ? 1 : 0)));
NODE
then
  fatal "egress port ${LISTEN_HOST}:${LISTEN_PORT} is owned by an unrecognized listener"
fi

uid="$(id -u "$SERVICE_USER")"
gid="$(id -g "$SERVICE_USER")"
: >"$LOG_FILE"
chmod 0640 "$LOG_FILE"
screen -dmS "$SCREEN_NAME" bash -lc "exec setpriv --reuid=${uid} --regid=${gid} --init-groups --no-new-privs '${INSTALL_ROOT}/run.sh' >>'${LOG_FILE}' 2>&1"

health_url="${PROXY_URL}/_div3rsa_health"
deadline=$((SECONDS + ${DIV3RSA_EGRESS_BOOT_TIMEOUT_SECONDS:-30}))
while ! curl --fail --silent --show-error --max-time 2 "$health_url" >/dev/null 2>&1; do
  if ! screen -list | grep -F ".${SCREEN_NAME}" >/dev/null 2>&1; then
    tail -n 120 "$LOG_FILE" >&2 || true
    fatal "egress proxy screen exited before health"
  fi
  if (( SECONDS >= deadline )); then
    tail -n 120 "$LOG_FILE" >&2 || true
    fatal "egress proxy did not become healthy"
  fi
  sleep 1
done

assert_proxy_blocked() {
  local target="$1" label="$2" code
  code="$(curl --silent --show-error --max-time 5 --output /dev/null --write-out '%{http_code}' --proxy "$PROXY_URL" "$target" || true)"
  [[ "$code" == "403" ]] || fatal "egress negative gate failed for ${label}: http_status=${code:-none}"
}

assert_proxy_blocked "http://127.0.0.1/" "loopback"
assert_proxy_blocked "http://169.254.169.254/latest/meta-data/" "cloud metadata"

if [[ "${DIV3RSA_EGRESS_SKIP_PUBLIC_PROBE:-0}" != "1" ]]; then
  curl --fail --silent --show-error --max-time 10 --proxy "$PROXY_URL" https://example.com/ >/dev/null \
    || fatal "egress public HTTPS probe failed"
fi

screen -list | grep -F ".${SCREEN_NAME}" >/dev/null || fatal "egress proxy screen is not active"
log "egress proxy healthy at ${PROXY_URL}; screen=${SCREEN_NAME}; public-only DNS-pinned policy enforced"
printf 'DIV3RSA_EGRESS_PROXY_URL=%s\n' "$PROXY_URL"
