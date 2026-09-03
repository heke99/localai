#!/usr/bin/env bash
set -Eeuo pipefail

log() { printf '[gpuhub-browser] %s\n' "$*"; }
fatal() { log "$*" >&2; exit 1; }

[[ "${EUID}" -eq 0 ]] || fatal "run as root on GPUHub"

ROOT_DIR="${DIV3RSA_LEGACY_ROOT_DIR:-/root/autodl-tmp/localai}"
REPO_DIR="${DIV3RSA_LEGACY_APP_DIR:-${ROOT_DIR}/app}"
NODE_BIN="${DIV3RSA_LEGACY_NODE_BIN:-${ROOT_DIR}/runtime/node-current/bin/node}"
INSTALL_ROOT="${DIV3RSA_BROWSER_INSTALL_ROOT:-/opt/div3rsa/browser-executor}"
STATE_ROOT="${DIV3RSA_BROWSER_STATE_ROOT:-/var/lib/div3rsa-browser}"
LOG_DIR="${DIV3RSA_LEGACY_LOG_DIR:-${ROOT_DIR}/logs}"
LOG_FILE="${LOG_DIR}/browser-executor.log"
SCREEN_NAME="${DIV3RSA_BROWSER_SCREEN_NAME:-localai-browser}"
SERVICE_USER="div3rsa-browser"
LISTEN_HOST="127.0.0.1"
LISTEN_PORT="${DIV3RSA_BROWSER_EXECUTOR_PORT:-7320}"
BROWSER_URL="http://${LISTEN_HOST}:${LISTEN_PORT}"
EGRESS_URL="${DIV3RSA_EGRESS_PROXY_URL:-http://127.0.0.1:7318}"
TOKEN_FILE="${DIV3RSA_BROWSER_EXECUTOR_TOKEN_FILE:-${STATE_ROOT}/executor.token}"
ENV_FILE="${DIV3RSA_BROWSER_EXECUTOR_ENV_FILE:-${STATE_ROOT}/executor.env}"
PLAYWRIGHT_VERSION="1.62.1"
BROWSERS_PATH="${INSTALL_ROOT}/browsers"
PACKAGE_FILE="${INSTALL_ROOT}/package.json"

[[ -d "$REPO_DIR" ]] || fatal "repository missing: $REPO_DIR"
[[ -f "$REPO_DIR/services/browser-executor/src/main.ts" ]] || fatal "browser executor source missing"
[[ -f "$REPO_DIR/services/browser-executor/src/policy.ts" ]] || fatal "browser executor policy missing"
[[ -f "$REPO_DIR/infra/runpod/native-typescript-register.mjs" ]] || fatal "native TypeScript resolver missing"
if [[ ! -x "$NODE_BIN" ]]; then
  NODE_BIN="$(command -v node || true)"
fi
[[ -n "$NODE_BIN" && -x "$NODE_BIN" ]] || fatal "Node.js 24 runtime missing"
"$NODE_BIN" -e 'if(Number(process.versions.node.split(".")[0])<24)process.exit(1)' || fatal "Node.js >=24 is required"
for cmd in npm curl screen setpriv useradd; do command -v "$cmd" >/dev/null 2>&1 || fatal "$cmd is required"; done

curl --fail --silent --show-error --max-time 3 "${EGRESS_URL}/_div3rsa_health" >/dev/null \
  || fatal "egress proxy must be healthy before browser provisioning"

if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "$STATE_ROOT" --shell /usr/sbin/nologin "$SERVICE_USER"
fi
mkdir -p "$LOG_DIR"
install -d -o root -g "$SERVICE_USER" -m 0750 "$INSTALL_ROOT"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0700 "$STATE_ROOT"

install -o root -g "$SERVICE_USER" -m 0640 "$REPO_DIR/services/browser-executor/src/main.ts" "$INSTALL_ROOT/main.ts"
install -o root -g "$SERVICE_USER" -m 0640 "$REPO_DIR/services/browser-executor/src/policy.ts" "$INSTALL_ROOT/policy.ts"
install -o root -g "$SERVICE_USER" -m 0640 "$REPO_DIR/infra/runpod/native-typescript-register.mjs" "$INSTALL_ROOT/native-typescript-register.mjs"

current_version=""
if [[ -f "$INSTALL_ROOT/node_modules/@playwright/test/package.json" ]]; then
  current_version="$($NODE_BIN -e 'const p=require(process.argv[1]);process.stdout.write(p.version||"")' "$INSTALL_ROOT/node_modules/@playwright/test/package.json" 2>/dev/null || true)"
fi
if [[ "$current_version" != "$PLAYWRIGHT_VERSION" ]]; then
  log "installing pinned @playwright/test@${PLAYWRIGHT_VERSION}"
  cat >"$PACKAGE_FILE" <<EOF
{"name":"div3rsa-gpuhub-browser-runtime","private":true,"version":"1.0.0","dependencies":{"@playwright/test":"${PLAYWRIGHT_VERSION}"}}
EOF
  npm --prefix "$INSTALL_ROOT" install --omit=dev --ignore-scripts --no-audit --no-fund --save-exact "@playwright/test@${PLAYWRIGHT_VERSION}"
fi

PLAYWRIGHT_BIN="$INSTALL_ROOT/node_modules/.bin/playwright"
[[ -x "$PLAYWRIGHT_BIN" ]] || fatal "Playwright CLI missing after install"

DEPS_MARKER="$INSTALL_ROOT/.os-deps-${PLAYWRIGHT_VERSION}"
if [[ ! -f "$DEPS_MARKER" && "${DIV3RSA_BROWSER_INSTALL_OS_DEPS:-1}" != "0" ]]; then
  log "installing Chromium OS dependencies"
  PLAYWRIGHT_BROWSERS_PATH="$BROWSERS_PATH" "$PLAYWRIGHT_BIN" install-deps chromium
  touch "$DEPS_MARKER"
fi

log "ensuring pinned Chromium browser payload"
PLAYWRIGHT_BROWSERS_PATH="$BROWSERS_PATH" "$PLAYWRIGHT_BIN" install chromium
chown -R root:"$SERVICE_USER" "$INSTALL_ROOT"
chmod -R g+rX "$INSTALL_ROOT"
chmod 0750 "$INSTALL_ROOT" "$BROWSERS_PATH" 2>/dev/null || true

if [[ ! -s "$TOKEN_FILE" ]]; then
  umask 077
  "$NODE_BIN" -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))' >"$TOKEN_FILE"
  printf '\n' >>"$TOKEN_FILE"
fi
chmod 0640 "$TOKEN_FILE"
chown root:"$SERVICE_USER" "$TOKEN_FILE"
TOKEN="$(tr -d '\r\n' <"$TOKEN_FILE")"
[[ "$TOKEN" =~ ^[0-9a-f]{64}$ ]] || fatal "browser executor token is invalid"

umask 027
cat >"$ENV_FILE" <<EOF
DIV3RSA_BROWSER_EXECUTOR_TOKEN=${TOKEN}
DIV3RSA_BROWSER_EXECUTOR_HOST=${LISTEN_HOST}
DIV3RSA_BROWSER_EXECUTOR_PORT=${LISTEN_PORT}
DIV3RSA_EGRESS_PROXY_URL=${EGRESS_URL}
PLAYWRIGHT_BROWSERS_PATH=${BROWSERS_PATH}
HOME=${STATE_ROOT}
EOF
chown root:"$SERVICE_USER" "$ENV_FILE"
chmod 0640 "$ENV_FILE"

cat >"$INSTALL_ROOT/run.sh" <<EOF
#!/usr/bin/env bash
set -Eeuo pipefail
set -a
source ${ENV_FILE}
set +a
cd ${INSTALL_ROOT}
exec ${NODE_BIN} --experimental-transform-types --import ${INSTALL_ROOT}/native-typescript-register.mjs ${INSTALL_ROOT}/main.ts
EOF
chown root:"$SERVICE_USER" "$INSTALL_ROOT/run.sh"
chmod 0750 "$INSTALL_ROOT/run.sh"

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
  fatal "browser port ${LISTEN_HOST}:${LISTEN_PORT} is owned by an unrecognized listener"
fi

uid="$(id -u "$SERVICE_USER")"
gid="$(id -g "$SERVICE_USER")"
: >"$LOG_FILE"
chmod 0640 "$LOG_FILE"
screen -dmS "$SCREEN_NAME" bash -lc "exec setpriv --reuid=${uid} --regid=${gid} --init-groups --no-new-privs '${INSTALL_ROOT}/run.sh' >>'${LOG_FILE}' 2>&1"

deadline=$((SECONDS + ${DIV3RSA_BROWSER_BOOT_TIMEOUT_SECONDS:-60}))
while ! curl --fail --silent --show-error --max-time 2 "${BROWSER_URL}/health" >/dev/null 2>&1; do
  if ! screen -list | grep -F ".${SCREEN_NAME}" >/dev/null 2>&1; then
    tail -n 160 "$LOG_FILE" >&2 || true
    fatal "browser executor screen exited before health"
  fi
  if (( SECONDS >= deadline )); then
    tail -n 160 "$LOG_FILE" >&2 || true
    fatal "browser executor did not become healthy"
  fi
  sleep 1
done

screen -list | grep -F ".${SCREEN_NAME}" >/dev/null || fatal "browser executor screen is not active"
log "browser executor healthy at ${BROWSER_URL}; screen=${SCREEN_NAME}; outbound browser traffic forced through ${EGRESS_URL}"
printf 'DIV3RSA_BROWSER_EXECUTOR_URL=%s\n' "$BROWSER_URL"
