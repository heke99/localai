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
SERVICE_NAME="div3rsa-browser-executor.service"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}"
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
command -v npm >/dev/null 2>&1 || fatal "npm is required"
command -v curl >/dev/null 2>&1 || fatal "curl is required"
command -v systemctl >/dev/null 2>&1 || fatal "systemd is required"

curl --fail --silent --show-error --max-time 3 "${EGRESS_URL}/_div3rsa_health" >/dev/null \
  || fatal "egress proxy must be healthy before browser provisioning"

if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "$STATE_ROOT" --shell /usr/sbin/nologin "$SERVICE_USER"
fi
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

cat >"$SERVICE_FILE" <<EOF
[Unit]
Description=DIV3RSA scoped Playwright browser executor
After=network-online.target div3rsa-egress-proxy.service
Wants=network-online.target
Requires=div3rsa-egress-proxy.service

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${INSTALL_ROOT}
EnvironmentFile=${ENV_FILE}
ExecStart=${NODE_BIN} --experimental-transform-types --import ${INSTALL_ROOT}/native-typescript-register.mjs ${INSTALL_ROOT}/main.ts
Restart=always
RestartSec=2
TimeoutStopSec=20
KillMode=mixed
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
CapabilityBoundingSet=
AmbientCapabilities=
ReadWritePaths=${STATE_ROOT}

[Install]
WantedBy=multi-user.target
EOF
chmod 0644 "$SERVICE_FILE"

systemctl daemon-reload
systemctl enable "$SERVICE_NAME" >/dev/null
systemctl restart "$SERVICE_NAME"

deadline=$((SECONDS + ${DIV3RSA_BROWSER_BOOT_TIMEOUT_SECONDS:-60}))
while ! curl --fail --silent --show-error --max-time 2 "${BROWSER_URL}/health" >/dev/null 2>&1; do
  if (( SECONDS >= deadline )); then
    systemctl --no-pager --full status "$SERVICE_NAME" >&2 || true
    journalctl -u "$SERVICE_NAME" -n 120 --no-pager >&2 || true
    fatal "browser executor did not become healthy"
  fi
  sleep 1
done

systemctl is-active --quiet "$SERVICE_NAME" || fatal "browser executor service is not active"
log "browser executor healthy at ${BROWSER_URL}; outbound browser traffic forced through ${EGRESS_URL}"
printf 'DIV3RSA_BROWSER_EXECUTOR_URL=%s\n' "$BROWSER_URL"
