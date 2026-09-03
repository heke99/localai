#!/usr/bin/env bash
set -Eeuo pipefail

log() { printf '[gpuhub-egress] %s\n' "$*"; }
fatal() { log "$*" >&2; exit 1; }

[[ "${EUID}" -eq 0 ]] || fatal "run as root on GPUHub"

ROOT_DIR="${DIV3RSA_LEGACY_ROOT_DIR:-/root/autodl-tmp/localai}"
REPO_DIR="${DIV3RSA_LEGACY_APP_DIR:-${ROOT_DIR}/app}"
NODE_BIN="${DIV3RSA_LEGACY_NODE_BIN:-${ROOT_DIR}/runtime/node-current/bin/node}"
INSTALL_ROOT="${DIV3RSA_EGRESS_INSTALL_ROOT:-/opt/div3rsa/egress-proxy}"
SERVICE_NAME="div3rsa-egress-proxy.service"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}"
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
command -v curl >/dev/null 2>&1 || fatal "curl is required"
command -v systemctl >/dev/null 2>&1 || fatal "systemd is required"

if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$SERVICE_USER"
fi

install -d -o root -g root -m 0755 "$INSTALL_ROOT"
install -o root -g root -m 0644 "$REPO_DIR/services/egress-proxy/src/main.ts" "$INSTALL_ROOT/main.ts"
install -o root -g root -m 0644 "$REPO_DIR/services/egress-proxy/src/policy.ts" "$INSTALL_ROOT/policy.ts"
install -o root -g root -m 0644 "$REPO_DIR/infra/runpod/native-typescript-register.mjs" "$INSTALL_ROOT/native-typescript-register.mjs"

cat >"$SERVICE_FILE" <<EOF
[Unit]
Description=DIV3RSA DNS-pinned public-web egress proxy
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${INSTALL_ROOT}
Environment=DIV3RSA_EGRESS_PROXY_HOST=${LISTEN_HOST}
Environment=DIV3RSA_EGRESS_PROXY_PORT=${LISTEN_PORT}
ExecStart=${NODE_BIN} --experimental-transform-types --import ${INSTALL_ROOT}/native-typescript-register.mjs ${INSTALL_ROOT}/main.ts
Restart=always
RestartSec=2
TimeoutStopSec=15
KillMode=mixed
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
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

[Install]
WantedBy=multi-user.target
EOF
chmod 0644 "$SERVICE_FILE"

systemctl daemon-reload
systemctl enable "$SERVICE_NAME" >/dev/null
systemctl restart "$SERVICE_NAME"

health_url="${PROXY_URL}/_div3rsa_health"
deadline=$((SECONDS + ${DIV3RSA_EGRESS_BOOT_TIMEOUT_SECONDS:-30}))
while ! curl --fail --silent --show-error --max-time 2 "$health_url" >/dev/null 2>&1; do
  if (( SECONDS >= deadline )); then
    systemctl --no-pager --full status "$SERVICE_NAME" >&2 || true
    journalctl -u "$SERVICE_NAME" -n 100 --no-pager >&2 || true
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

systemctl is-active --quiet "$SERVICE_NAME" || fatal "egress proxy service is not active"
log "egress proxy healthy at ${PROXY_URL}; public-only DNS-pinned policy enforced"
printf 'DIV3RSA_EGRESS_PROXY_URL=%s\n' "$PROXY_URL"
