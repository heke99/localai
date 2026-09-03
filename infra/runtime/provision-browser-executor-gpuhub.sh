#!/usr/bin/env bash
set -Eeuo pipefail

log() { printf '[gpuhub-browser] %s\n' "$*"; }
fatal() { log "$*" >&2; exit 1; }

[[ "${EUID}" -eq 0 ]] || fatal "run as root on GPUHub"

ROOT_DIR="${DIV3RSA_LEGACY_ROOT_DIR:-/root/autodl-tmp/localai}"
REPO_DIR="${DIV3RSA_LEGACY_APP_DIR:-${ROOT_DIR}/app}"
NODE_BIN="${DIV3RSA_LEGACY_NODE_BIN:-${ROOT_DIR}/runtime/node-current/bin/node}"
INSTALL_ROOT="${DIV3RSA_BROWSER_INSTALL_ROOT:-/opt/div3rsa/browser-executor}"
SIDECAR_NODE_BIN="${INSTALL_ROOT}/node"
STATE_ROOT="${DIV3RSA_BROWSER_STATE_ROOT:-/var/lib/div3rsa-browser}"
TMP_ROOT="${STATE_ROOT}/tmp"
RUNTIME_ROOT="${STATE_ROOT}/runtime"
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
UNAVAILABLE_FILE="${DIV3RSA_BROWSER_UNAVAILABLE_FILE:-${STATE_ROOT}/unavailable.reason}"
PLAYWRIGHT_VERSION="1.62.1"
BROWSERS_PATH="${INSTALL_ROOT}/browsers"
PACKAGE_FILE="${INSTALL_ROOT}/package.json"
APPARMOR_PROFILE="/etc/apparmor.d/div3rsa-browser-chromium"
IPTABLES_CHAIN="DIV3RSA_BROWSER"
IP6TABLES_CHAIN="DIV3RSA_BROWSER"

[[ -d "$REPO_DIR" ]] || fatal "repository missing: $REPO_DIR"
for source in \
  "$REPO_DIR/services/browser-executor/src/main.ts" \
  "$REPO_DIR/services/browser-executor/src/policy.ts" \
  "$REPO_DIR/services/browser-executor/src/runtime-policy.ts" \
  "$REPO_DIR/infra/runpod/native-typescript-register.mjs"; do
  [[ -f "$source" ]] || fatal "browser executor source missing: $source"
done
if [[ ! -x "$NODE_BIN" ]]; then
  NODE_BIN="$(command -v node || true)"
fi
[[ -n "$NODE_BIN" && -x "$NODE_BIN" ]] || fatal "Node.js 24 runtime missing"
"$NODE_BIN" -e 'if(Number(process.versions.node.split(".")[0])<24)process.exit(1)' || fatal "Node.js >=24 is required"
NODE_BIN_DIR="$(dirname "$NODE_BIN")"
NPM_BIN="${NODE_BIN_DIR}/npm"
if [[ ! -x "$NPM_BIN" ]]; then
  NPM_BIN="$(command -v npm || true)"
fi
[[ -n "$NPM_BIN" && -x "$NPM_BIN" ]] || fatal "npm paired with the Node runtime is required"
export PATH="${NODE_BIN_DIR}:$PATH"
for cmd in curl screen setpriv useradd find stat timeout; do command -v "$cmd" >/dev/null 2>&1 || fatal "$cmd is required"; done

curl --fail --silent --show-error --max-time 3 "${EGRESS_URL}/_div3rsa_health" >/dev/null \
  || fatal "egress proxy must be healthy before browser provisioning"

if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "$STATE_ROOT" --shell /usr/sbin/nologin "$SERVICE_USER"
fi
uid="$(id -u "$SERVICE_USER")"
gid="$(id -g "$SERVICE_USER")"
mkdir -p "$LOG_DIR"
install -d -o root -g "$SERVICE_USER" -m 0750 "$INSTALL_ROOT"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0700 "$STATE_ROOT" "$TMP_ROOT" "$RUNTIME_ROOT"
# Keep the canonical GPUHub Node installation private below /root. The browser
# account gets only an executable copy of the already-validated Node 24 binary.
install -o root -g "$SERVICE_USER" -m 0755 "$NODE_BIN" "$SIDECAR_NODE_BIN"
"$SIDECAR_NODE_BIN" -e 'if(Number(process.versions.node.split(".")[0])<24)process.exit(1)' || fatal "browser Node copy is invalid"

mark_host_isolation_unavailable() {
  screen -S "$SCREEN_NAME" -X quit >/dev/null 2>&1 || true
  rm -f "$TOKEN_FILE" "$ENV_FILE"
  printf '%s\n' 'unavailable_host_isolation' >"$UNAVAILABLE_FILE"
  chown root:"$SERVICE_USER" "$UNAVAILABLE_FILE"
  chmod 0640 "$UNAVAILABLE_FILE"
  log "browser unavailable: host cannot provide a safe Chromium or outer network isolation boundary"
  exit 78
}

install -o root -g "$SERVICE_USER" -m 0640 "$REPO_DIR/services/browser-executor/src/main.ts" "$INSTALL_ROOT/main.ts"
install -o root -g "$SERVICE_USER" -m 0640 "$REPO_DIR/services/browser-executor/src/policy.ts" "$INSTALL_ROOT/policy.ts"
install -o root -g "$SERVICE_USER" -m 0640 "$REPO_DIR/services/browser-executor/src/runtime-policy.ts" "$INSTALL_ROOT/runtime-policy.ts"
install -o root -g "$SERVICE_USER" -m 0640 "$REPO_DIR/infra/runpod/native-typescript-register.mjs" "$INSTALL_ROOT/native-typescript-register.mjs"

cat >"$PACKAGE_FILE" <<EOF
{"name":"div3rsa-gpuhub-browser-runtime","private":true,"version":"1.0.0","type":"module","dependencies":{"@playwright/test":"${PLAYWRIGHT_VERSION}"}}
EOF
current_version=""
if [[ -f "$INSTALL_ROOT/node_modules/@playwright/test/package.json" ]]; then
  current_version="$($NODE_BIN -e 'const p=require(process.argv[1]);process.stdout.write(p.version||"")' "$INSTALL_ROOT/node_modules/@playwright/test/package.json" 2>/dev/null || true)"
fi
if [[ "$current_version" != "$PLAYWRIGHT_VERSION" ]]; then
  log "installing pinned @playwright/test@${PLAYWRIGHT_VERSION}"
  "$NPM_BIN" --prefix "$INSTALL_ROOT" install --omit=dev --ignore-scripts --no-audit --no-fund --save-exact "@playwright/test@${PLAYWRIGHT_VERSION}"
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
chmod 0755 "$SIDECAR_NODE_BIN"
# Remove the previous SUID-helper experiment. Playwright's downloaded browser is
# not treated as a system Chrome installation; use user namespaces when possible
# and otherwise require an outer UID+firewall boundary.
rm -f "$INSTALL_ROOT/chrome-devel-sandbox"

CHROME_BINARY="$(find "$BROWSERS_PATH" -type f -path '*/chrome-linux64/chrome' -print | sort | tail -n1)"
[[ -n "$CHROME_BINARY" && -x "$CHROME_BINARY" ]] || fatal "full Chromium binary missing"

run_as_browser() {
  setpriv \
    --reuid="$uid" \
    --regid="$gid" \
    --init-groups \
    --no-new-privs \
    --bounding-set=-all \
    --inh-caps=-all \
    --ambient-caps=-all \
    "$@"
}

chromium_sandbox_probe() {
  rm -rf "$STATE_ROOT/sandbox-probe" >/dev/null 2>&1 || true
  install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0700 "$STATE_ROOT/sandbox-probe"
  run_as_browser env \
    HOME="$STATE_ROOT" \
    TMPDIR="$TMP_ROOT" \
    XDG_RUNTIME_DIR="$RUNTIME_ROOT" \
    timeout 12 "$CHROME_BINARY" \
      --headless \
      --disable-gpu \
      --no-first-run \
      --no-default-browser-check \
      --user-data-dir="$STATE_ROOT/sandbox-probe" \
      --dump-dom about:blank >/dev/null 2>&1
}

try_selective_apparmor_userns() {
  command -v apparmor_parser >/dev/null 2>&1 || return 1
  [[ -d /sys/kernel/security/apparmor || -e /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]] || return 1
  cat >"$APPARMOR_PROFILE" <<EOF
#include <tunables/global>
profile div3rsa-browser-chromium "${CHROME_BINARY}" flags=(unconfined) {
  userns,
}
EOF
  if ! apparmor_parser -r "$APPARMOR_PROFILE" >/dev/null 2>&1; then
    rm -f "$APPARMOR_PROFILE"
    return 1
  fi
  if chromium_sandbox_probe; then
    log "Chromium user-namespace sandbox enabled through selective AppArmor profile"
    return 0
  fi
  apparmor_parser -R "$APPARMOR_PROFILE" >/dev/null 2>&1 || true
  rm -f "$APPARMOR_PROFILE"
  return 1
}

ensure_firewall_tools() {
  if command -v iptables >/dev/null 2>&1 && command -v ip6tables >/dev/null 2>&1; then
    return 0
  fi
  command -v apt-get >/dev/null 2>&1 || return 1
  log "installing iptables for browser UID confinement"
  DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq iptables >/dev/null
  command -v iptables >/dev/null 2>&1 && command -v ip6tables >/dev/null 2>&1
}

reset_owner_jump() {
  local command_name="$1" chain="$2"
  while "$command_name" -C OUTPUT -m owner --uid-owner "$uid" -j "$chain" >/dev/null 2>&1; do
    "$command_name" -D OUTPUT -m owner --uid-owner "$uid" -j "$chain"
  done
}

configure_uid_firewall() {
  ensure_firewall_tools || return 1

  iptables -N "$IPTABLES_CHAIN" >/dev/null 2>&1 || true
  iptables -F "$IPTABLES_CHAIN" || return 1
  iptables -A "$IPTABLES_CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT || return 1
  iptables -A "$IPTABLES_CHAIN" -p tcp -d 127.0.0.1 --dport 7318 -j ACCEPT || return 1
  iptables -A "$IPTABLES_CHAIN" -j REJECT || return 1
  reset_owner_jump iptables "$IPTABLES_CHAIN"
  iptables -I OUTPUT 1 -m owner --uid-owner "$uid" -j "$IPTABLES_CHAIN" || return 1

  ip6tables -N "$IP6TABLES_CHAIN" >/dev/null 2>&1 || true
  ip6tables -F "$IP6TABLES_CHAIN" || return 1
  ip6tables -A "$IP6TABLES_CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT || return 1
  ip6tables -A "$IP6TABLES_CHAIN" -j REJECT || return 1
  reset_owner_jump ip6tables "$IP6TABLES_CHAIN"
  ip6tables -I OUTPUT 1 -m owner --uid-owner "$uid" -j "$IP6TABLES_CHAIN" || return 1

  # Prove that this UID cannot reach the model, the public internet, or DNS
  # directly, while the one permitted path through the DNS-pinned proxy works.
  if run_as_browser curl --silent --fail --max-time 3 http://127.0.0.1:6006/health >/dev/null 2>&1; then
    fatal "browser UID firewall still permits direct loopback access"
  fi
  if run_as_browser curl --silent --fail --max-time 5 https://example.com/ >/dev/null 2>&1; then
    fatal "browser UID firewall still permits direct public access"
  fi
  run_as_browser curl --silent --fail --max-time 10 --proxy "$EGRESS_URL" https://example.com/ >/dev/null \
    || fatal "browser UID firewall blocks the approved egress proxy"

  return 0
}

ISOLATION_MODE="chromium"
if chromium_sandbox_probe; then
  log "Chromium native user-namespace sandbox is available"
elif try_selective_apparmor_userns; then
  ISOLATION_MODE="chromium"
else
  log "Chromium user-namespace sandbox unavailable; requiring kernel UID firewall outer isolation"
  configure_uid_firewall || mark_host_isolation_unavailable
  ISOLATION_MODE="uid-firewall"
fi

rm -f "$UNAVAILABLE_FILE"
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
DIV3RSA_BROWSER_ISOLATION_MODE=${ISOLATION_MODE}
PLAYWRIGHT_BROWSERS_PATH=${BROWSERS_PATH}
HOME=${STATE_ROOT}
TMPDIR=${TMP_ROOT}
XDG_RUNTIME_DIR=${RUNTIME_ROOT}
EOF
chown root:"$SERVICE_USER" "$ENV_FILE"
chmod 0640 "$ENV_FILE"

cat >"$INSTALL_ROOT/run.sh" <<EOF
#!/usr/bin/env bash
set -Eeuo pipefail
ulimit -c 0
ulimit -n 1024
ulimit -u 512 2>/dev/null || true
set -a
source ${ENV_FILE}
set +a
cd ${INSTALL_ROOT}
exec ${SIDECAR_NODE_BIN} --experimental-transform-types --import ${INSTALL_ROOT}/native-typescript-register.mjs ${INSTALL_ROOT}/main.ts
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

: >"$LOG_FILE"
chmod 0640 "$LOG_FILE"
screen -dmS "$SCREEN_NAME" bash -lc "exec setpriv --reuid=${uid} --regid=${gid} --init-groups --no-new-privs --bounding-set=-all --inh-caps=-all --ambient-caps=-all '${INSTALL_ROOT}/run.sh' >>'${LOG_FILE}' 2>&1"

deadline=$((SECONDS + ${DIV3RSA_BROWSER_BOOT_TIMEOUT_SECONDS:-60}))
while ! curl --fail --silent --show-error --max-time 2 "${BROWSER_URL}/health" >/dev/null 2>&1; do
  if ! screen -list | grep -F ".${SCREEN_NAME}" >/dev/null 2>&1; then
    tail -n 180 "$LOG_FILE" >&2 || true
    fatal "browser executor screen exited before health"
  fi
  if (( SECONDS >= deadline )); then
    tail -n 180 "$LOG_FILE" >&2 || true
    fatal "browser executor did not become healthy"
  fi
  sleep 1
done

health="$(curl --fail --silent --show-error --max-time 3 "${BROWSER_URL}/health")"
"$NODE_BIN" -e 'const h=JSON.parse(process.argv[1]);if(h.ok!==true||h.isolation!==process.argv[2])process.exit(1)' "$health" "$ISOLATION_MODE" \
  || fatal "browser executor health does not report selected isolation mode"
screen -list | grep -F ".${SCREEN_NAME}" >/dev/null || fatal "browser executor screen is not active"
log "browser executor healthy at ${BROWSER_URL}; screen=${SCREEN_NAME}; isolation=${ISOLATION_MODE}; outbound browser traffic forced through ${EGRESS_URL}"
printf 'DIV3RSA_BROWSER_EXECUTOR_URL=%s\n' "$BROWSER_URL"