#!/usr/bin/env bash
set -Eeuo pipefail

log() { printf '[security-cutover] %s\n' "$*"; }
fatal() { log "$*" >&2; exit 1; }

ROOT_DIR="${DIV3RSA_LEGACY_ROOT_DIR:-/root/autodl-tmp/localai}"
APP_DIR="${DIV3RSA_LEGACY_APP_DIR:-${ROOT_DIR}/app}"
WORKER_SCREEN="${DIV3RSA_LEGACY_WORKER_SCREEN:-localai-agent}"
TEST_IFACE="${DIV3RSA_SECURITY_E2E_IFACE:-div3rsae2e0}"
TEST_IP="${DIV3RSA_SECURITY_E2E_IP:-10.254.254.1}"
TEST_PORT="${DIV3RSA_SECURITY_E2E_PORT:-18080}"
FIXTURE_PID=""
IFACE_CREATED=0

[[ "${EUID}" -eq 0 ]] || fatal "run as root on GPUHub"
for cmd in curl screen; do command -v "$cmd" >/dev/null 2>&1 || fatal "required command missing: $cmd"; done
[[ -d "$APP_DIR/.git" ]] || fatal "GPUHub checkout missing: $APP_DIR"

cleanup() {
  if [[ -n "$FIXTURE_PID" ]]; then kill "$FIXTURE_PID" >/dev/null 2>&1 || true; fi
  if [[ "$IFACE_CREATED" == "1" ]]; then ip link del "$TEST_IFACE" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

cd "$APP_DIR"
log "provisioning isolated executor"
DIV3RSA_REPOSITORY_ROOT="$APP_DIR" \
DIV3RSA_NODE_BIN="${ROOT_DIR}/runtime/node-current/bin/node" \
  bash infra/runtime/provision-security-executor.sh
command -v ip >/dev/null 2>&1 || fatal "iproute2 was not installed by security provisioning"

# Provisioning changes worker environment. Restart only the worker; recovery-v2
# observes healthy Qwen and starts the worker against the active runtime profile.
screen -S "$WORKER_SCREEN" -X quit >/dev/null 2>&1 || true
bash infra/runtime/recover-legacy-gpuhub.sh
screen -list | grep -F ".${WORKER_SCREEN}" >/dev/null || fatal "agent worker unavailable after security cutover"

log "running mandatory negative executor gates"
bash infra/runtime/e2e-security-executor.sh

# Build an owned ephemeral target inside the GPUHub host. The executor must cross
# the real network stack to reach it, but no third-party system is touched.
if ip link show "$TEST_IFACE" >/dev/null 2>&1; then
  ip link del "$TEST_IFACE"
fi
ip link add "$TEST_IFACE" type dummy
IFACE_CREATED=1
ip addr add "${TEST_IP}/32" dev "$TEST_IFACE"
ip link set "$TEST_IFACE" up

NODE_BIN="${ROOT_DIR}/runtime/node-current/bin/node"
[[ -x "$NODE_BIN" ]] || fatal "GPUHub Node runtime unavailable"
"$NODE_BIN" -e '
  const http=require("http");
  const host=process.argv[1], port=Number(process.argv[2]);
  const server=http.createServer((req,res)=>{res.writeHead(200,{"content-type":"text/plain"});res.end("DIV3RSA_SECURITY_E2E_OK\n")});
  server.listen(port,host);
' "$TEST_IP" "$TEST_PORT" >/tmp/div3rsa-security-e2e-fixture.log 2>&1 &
FIXTURE_PID=$!

for _ in {1..30}; do
  curl --fail --silent --max-time 1 "http://${TEST_IP}:${TEST_PORT}/" >/dev/null 2>&1 && break
  sleep 0.2
done
curl --fail --silent --show-error --max-time 2 "http://${TEST_IP}:${TEST_PORT}/" | grep -Fq 'DIV3RSA_SECURITY_E2E_OK' || fatal "controlled E2E fixture unavailable"

log "running controlled passive and bounded active executor gates"
DIV3RSA_SECURITY_E2E_TARGET="http://${TEST_IP}:${TEST_PORT}/" \
DIV3RSA_SECURITY_E2E_ACTIVE=1 \
DIV3RSA_SECURITY_E2E_ACTIVE_PORTS="$TEST_PORT" \
  bash infra/runtime/e2e-security-executor.sh

# Prove the worker actually loaded the newly written executor configuration.
worker_pid="$(pgrep -f 'services/agent-worker/src/main\.ts' | head -n1 || true)"
[[ -n "$worker_pid" ]] || fatal "agent worker PID unavailable"
tr '\0' '\n' <"/proc/${worker_pid}/environ" | grep -Fxq 'DIV3RSA_SECURITY_TOOL_RUNTIME_ENABLED=1' || fatal "worker did not load security runtime enablement"
tr '\0' '\n' <"/proc/${worker_pid}/environ" | grep -Fxq 'DIV3RSA_SECURITY_EXECUTOR_URL=http://127.0.0.1:7319' || fatal "worker did not load executor URL"

systemctl is-active --quiet div3rsa-security-executor.service || fatal "security executor service not active"
curl --fail --silent --show-error --max-time 3 http://127.0.0.1:7319/health >/dev/null
log "GPUHub security runtime live cutover passed"
printf 'GPUHUB_SECURITY_RUNTIME_E2E_OK\n'
