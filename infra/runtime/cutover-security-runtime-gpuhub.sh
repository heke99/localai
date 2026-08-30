#!/usr/bin/env bash
set -Eeuo pipefail

log() { printf '[security-cutover] %s\n' "$*"; }
fatal() { log "$*" >&2; exit 1; }

ROOT_DIR="${DIV3RSA_LEGACY_ROOT_DIR:-/root/autodl-tmp/localai}"
APP_DIR="${DIV3RSA_LEGACY_APP_DIR:-${ROOT_DIR}/app}"
WORKER_SCREEN="${DIV3RSA_LEGACY_WORKER_SCREEN:-localai-agent}"
WORKER_ENV_FILE="${DIV3RSA_AGENT_WORKER_ENV_FILE:-${ROOT_DIR}/secrets/gpuhub-worker.env}"
TEST_IFACE="${DIV3RSA_SECURITY_E2E_IFACE:-div3rsae2e0}"
TEST_IP="${DIV3RSA_SECURITY_E2E_IP:-10.254.254.1}"
TEST_PORT="${DIV3RSA_SECURITY_E2E_PORT:-18080}"
TEST_TLS_PORT="${DIV3RSA_SECURITY_E2E_TLS_PORT:-18443}"
TOOLS_ROOT="${DIV3RSA_SECURITY_TOOLS_ROOT:-/opt/div3rsa/security-tools}"
INSTALL_ROOT="${DIV3RSA_SECURITY_INSTALL_ROOT:-/opt/div3rsa/localai}"
ENV_FILE="${DIV3RSA_SECURITY_ENV_FILE:-/etc/div3rsa/security-executor.env}"
READINESS_DIR="${DIV3RSA_SECURITY_READINESS_DIR:-/var/lib/div3rsa}"
READINESS_FILE="${DIV3RSA_SECURITY_READINESS_FILE:-${READINESS_DIR}/security-runtime-readiness.json}"
FIXTURE_PID=""
IFACE_CREATED=0
TLS_DIR=""

[[ "${EUID}" -eq 0 ]] || fatal "run as root on GPUHub"
for cmd in curl screen openssl; do command -v "$cmd" >/dev/null 2>&1 || fatal "required command missing: $cmd"; done
[[ -d "$APP_DIR/.git" ]] || fatal "GPUHub checkout missing: $APP_DIR"
[[ -f "$WORKER_ENV_FILE" ]] || fatal "GPUHub worker env missing: $WORKER_ENV_FILE"

security_supervisor() {
  DIV3RSA_SECURITY_INSTALL_ROOT="$INSTALL_ROOT" \
  DIV3RSA_SECURITY_ENV_FILE="$ENV_FILE" \
    bash "$INSTALL_ROOT/infra/runtime/security-executor-supervisor.sh" "$1"
}

cleanup() {
  if [[ -n "$FIXTURE_PID" ]]; then kill "$FIXTURE_PID" >/dev/null 2>&1 || true; fi
  if [[ "$IFACE_CREATED" == "1" ]]; then ip link del "$TEST_IFACE" >/dev/null 2>&1 || true; fi
  if [[ -n "$TLS_DIR" ]]; then rm -rf "$TLS_DIR"; fi
}
trap cleanup EXIT

cd "$APP_DIR"
log "provisioning isolated executor with deterministic discovery assets"
DIV3RSA_REPOSITORY_ROOT="$APP_DIR" \
DIV3RSA_NODE_BIN="${ROOT_DIR}/runtime/node-current/bin/node" \
DIV3RSA_SECURITY_WORDLIST_SOURCE="$APP_DIR/infra/runtime/security-assets/common-wordlist.txt" \
  bash infra/runtime/provision-security-executor.sh
command -v ip >/dev/null 2>&1 || fatal "iproute2 was not installed by security provisioning"

# Nuclei runs under a locked service account with HOME=/nonexistent. Keep its
# production template root explicit and immutable instead of relying on a user
# home download. Additional reviewed templates can be installed into this root.
install -d -o root -g div3rsa-security -m 0750 "$TOOLS_ROOT/nuclei-templates"
install -o root -g div3rsa-security -m 0640 \
  "$APP_DIR/infra/runtime/security-assets/nuclei-readiness.yaml" \
  "$TOOLS_ROOT/nuclei-templates/div3rsa-readiness.yaml"
if [[ ! -x "$TOOLS_ROOT/bin/nuclei-real" ]]; then
  mv "$TOOLS_ROOT/bin/nuclei" "$TOOLS_ROOT/bin/nuclei-real"
fi
cat >"$TOOLS_ROOT/bin/nuclei" <<EOF
#!/usr/bin/env bash
set -Eeuo pipefail
REAL="$TOOLS_ROOT/bin/nuclei-real"
TEMPLATES="$TOOLS_ROOT/nuclei-templates"
for arg in "\$@"; do
  case "\$arg" in
    -version|-h|-help|--help) exec "\$REAL" "\$@" ;;
  esac
done
exec "\$REAL" -t "\$TEMPLATES" "\$@"
EOF
chmod 0755 "$TOOLS_ROOT/bin/nuclei"
security_supervisor restart
curl --fail --silent --show-error --max-time 3 http://127.0.0.1:7319/health >/dev/null

# Provisioning changes worker environment. Restart only the worker; recovery-v2
# observes healthy Qwen and starts the worker against the active runtime profile.
screen -S "$WORKER_SCREEN" -X quit >/dev/null 2>&1 || true
bash infra/runtime/recover-legacy-gpuhub.sh
screen -list | grep -F ".${WORKER_SCREEN}" >/dev/null || fatal "agent worker unavailable after security cutover"

log "running mandatory negative executor gates"
bash infra/runtime/e2e-security-executor.sh

# Build owned ephemeral HTTP + TLS targets inside the GPUHub host. No third-party
# system is touched by active readiness probes.
if ip link show "$TEST_IFACE" >/dev/null 2>&1; then
  ip link del "$TEST_IFACE"
fi
ip link add "$TEST_IFACE" type dummy
IFACE_CREATED=1
ip addr add "${TEST_IP}/32" dev "$TEST_IFACE"
ip link set "$TEST_IFACE" up

NODE_BIN="${ROOT_DIR}/runtime/node-current/bin/node"
[[ -x "$NODE_BIN" ]] || fatal "GPUHub Node runtime unavailable"
TLS_DIR="$(mktemp -d)"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -keyout "$TLS_DIR/key.pem" -out "$TLS_DIR/cert.pem" \
  -subj "/CN=${TEST_IP}" -addext "subjectAltName=IP:${TEST_IP}" >/dev/null 2>&1
"$NODE_BIN" -e '
  const fs=require("fs"), http=require("http"), https=require("https");
  const [host,httpPort,tlsPort,keyPath,certPath]=process.argv.slice(1);
  const handler=(req,res)=>{res.writeHead(200,{"content-type":"text/plain","x-div3rsa-readiness":"1"});res.end("DIV3RSA_SECURITY_E2E_OK\n")};
  http.createServer(handler).listen(Number(httpPort),host);
  https.createServer({key:fs.readFileSync(keyPath),cert:fs.readFileSync(certPath)},handler).listen(Number(tlsPort),host);
' "$TEST_IP" "$TEST_PORT" "$TEST_TLS_PORT" "$TLS_DIR/key.pem" "$TLS_DIR/cert.pem" >/tmp/div3rsa-security-e2e-fixture.log 2>&1 &
FIXTURE_PID=$!

for _ in {1..40}; do
  curl --fail --silent --max-time 1 "http://${TEST_IP}:${TEST_PORT}/" >/dev/null 2>&1 && break
  sleep 0.2
done
curl --fail --silent --show-error --max-time 2 "http://${TEST_IP}:${TEST_PORT}/" | grep -Fq 'DIV3RSA_SECURITY_E2E_OK' || fatal "controlled HTTP E2E fixture unavailable"
curl --insecure --fail --silent --show-error --max-time 2 "https://${TEST_IP}:${TEST_TLS_PORT}/" | grep -Fq 'DIV3RSA_SECURITY_E2E_OK' || fatal "controlled TLS E2E fixture unavailable"

log "running controlled passive and bounded active executor gates"
DIV3RSA_SECURITY_E2E_TARGET="http://${TEST_IP}:${TEST_PORT}/" \
DIV3RSA_SECURITY_E2E_ACTIVE=1 \
DIV3RSA_SECURITY_E2E_ACTIVE_PORTS="$TEST_PORT,$TEST_TLS_PORT" \
  bash infra/runtime/e2e-security-executor.sh

# Prove the real worker loaded the newly written executor configuration.
worker_pid="$(pgrep -f 'services/agent-worker/src/main\.ts' | head -n1 || true)"
[[ -n "$worker_pid" ]] || fatal "agent worker PID unavailable"
tr '\0' '\n' <"/proc/${worker_pid}/environ" | grep -Fxq 'DIV3RSA_SECURITY_TOOL_RUNTIME_ENABLED=1' || fatal "worker did not load security runtime enablement"
tr '\0' '\n' <"/proc/${worker_pid}/environ" | grep -Fxq 'DIV3RSA_SECURITY_EXECUTOR_URL=http://127.0.0.1:7319' || fatal "worker did not load executor URL"

log "running mandatory Qwen -> agent -> executor -> audit readiness gate"
set -a
# shellcheck disable=SC1090
source "$WORKER_ENV_FILE"
set +a
export DIV3RSA_REPOSITORY_ROOT="$APP_DIR"
export DIV3RSA_SECURITY_E2E_IP="$TEST_IP"
export DIV3RSA_SECURITY_E2E_PORT="$TEST_PORT"
export DIV3RSA_SECURITY_E2E_TLS_PORT="$TEST_TLS_PORT"
READINESS_TMP="$(mktemp)"
if ! "$NODE_BIN" --experimental-transform-types --import ./infra/runpod/native-typescript-register.mjs \
  scripts/eval_security_agent_gpuhub.ts >"$READINESS_TMP"; then
  cat "$READINESS_TMP" >&2 || true
  rm -f "$READINESS_TMP"
  fatal "full security agent readiness gate failed"
fi
cat "$READINESS_TMP"
"$NODE_BIN" -e 'const fs=require("fs"); const v=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(v.allowed!==true||v.cases!==6||v.passed!==6) process.exit(1)' "$READINESS_TMP" || {
  rm -f "$READINESS_TMP"
  fatal "security readiness summary rejected"
}

install -d -o root -g root -m 0755 "$READINESS_DIR"
current_sha="$(git rev-parse HEAD)"
"$NODE_BIN" -e '
  const fs=require("fs");
  const source=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  const marker={schemaVersion:1,ready:true,commit:process.argv[3],verifiedAt:new Date().toISOString(),cases:source.cases,passed:source.passed,tools:source.results.map(r=>({tool:r.tool,auditId:r.auditId,capability:r.capability}))};
  fs.writeFileSync(process.argv[2],JSON.stringify(marker,null,2)+"\n",{mode:0o644});
' "$READINESS_TMP" "$READINESS_FILE" "$current_sha"
rm -f "$READINESS_TMP"

security_supervisor status || fatal "security executor supervisor not active"
curl --fail --silent --show-error --max-time 3 http://127.0.0.1:7319/health >/dev/null
"$NODE_BIN" -e 'const fs=require("fs"); const v=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(v.ready!==true||v.commit!==process.argv[2]||v.cases!==6||v.passed!==6) process.exit(1)' "$READINESS_FILE" "$current_sha" || fatal "security readiness marker invalid or stale"
log "GPUHub security runtime live cutover and full agent readiness passed"
printf 'GPUHUB_SECURITY_RUNTIME_AGENT_E2E_OK\n'
