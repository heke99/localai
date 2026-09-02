#!/usr/bin/env bash
set -Eeuo pipefail

log() { printf '[nuclei-runtime] %s\n' "$*"; }
fatal() { log "$*" >&2; exit 1; }

SOURCE_ROOT="${DIV3RSA_REPOSITORY_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
TOOLS_ROOT="${DIV3RSA_SECURITY_TOOLS_ROOT:-/opt/div3rsa/security-tools}"
CLI_HOME="${DIV3RSA_SECURITY_CLI_HOME:-${TOOLS_ROOT}/runtime-home}"
TEST_IP="${DIV3RSA_SECURITY_E2E_IP:-127.0.0.1}"
TEST_PORT="${DIV3RSA_SECURITY_E2E_PORT:-18080}"
NODE_BIN="${DIV3RSA_SECURITY_NODE_BIN:-${TOOLS_ROOT}/node/bin/node}"
SNAPSHOT_ROOT="${DIV3RSA_NUCLEI_TEMPLATE_SNAPSHOT_ROOT:-${TOOLS_ROOT}/nuclei-template-snapshots}"
READINESS_ROOT="${TOOLS_ROOT}/nuclei-readiness"
RUNTIME_ROOT="${TOOLS_ROOT}/runtime"
CONFIG_FILE="${RUNTIME_ROOT}/nuclei-runtime.env"

[[ "${EUID}" -eq 0 ]] || fatal "run as root on the runtime host"
[[ -x "$NODE_BIN" ]] || fatal "isolated Node runtime missing: $NODE_BIN"
[[ -f "$SOURCE_ROOT/infra/runtime/security-assets/nuclei-scope-proxy.mjs" ]] || fatal "Nuclei scope proxy source missing"
[[ -f "$SOURCE_ROOT/infra/runtime/security-assets/nuclei-wrapper.sh" ]] || fatal "Nuclei wrapper source missing"
[[ -f "$SOURCE_ROOT/infra/runtime/security-assets/nuclei-readiness.yaml" ]] || fatal "Nuclei readiness template missing"
[[ -f "$SOURCE_ROOT/infra/runtime/provision-nuclei-template-snapshot.sh" ]] || fatal "Nuclei snapshot provisioner missing"

DIV3RSA_SECURITY_TOOLS_ROOT="$TOOLS_ROOT" \
  bash "$SOURCE_ROOT/infra/runtime/provision-nuclei-template-snapshot.sh"

install -d -o root -g div3rsa-security -m 0750 "$RUNTIME_ROOT" "$READINESS_ROOT"
install -d -o div3rsa-security -g div3rsa-security -m 0700 "$CLI_HOME" "$CLI_HOME/.config" "$CLI_HOME/.cache" "$CLI_HOME/tmp"
install -o root -g div3rsa-security -m 0640 \
  "$SOURCE_ROOT/infra/runtime/security-assets/nuclei-scope-proxy.mjs" \
  "$RUNTIME_ROOT/nuclei-scope-proxy.mjs"
install -o root -g div3rsa-security -m 0640 \
  "$SOURCE_ROOT/infra/runtime/security-assets/nuclei-readiness.yaml" \
  "$READINESS_ROOT/div3rsa-readiness.yaml"

if [[ ! -x "$TOOLS_ROOT/bin/nuclei-real" ]]; then
  [[ -x "$TOOLS_ROOT/bin/nuclei" ]] || fatal "Nuclei binary missing"
  mv "$TOOLS_ROOT/bin/nuclei" "$TOOLS_ROOT/bin/nuclei-real"
fi
REAL="$TOOLS_ROOT/bin/nuclei-real"
[[ -x "$REAL" ]] || fatal "real Nuclei binary unavailable"

for dir in cves exposed-panels exposures misconfiguration technologies vulnerabilities; do
  [[ -d "$SNAPSHOT_ROOT/current/http/$dir" ]] || fatal "curated Nuclei snapshot missing http/$dir"
done

cat > "$CONFIG_FILE" <<EOF
DIV3RSA_NUCLEI_REAL_BIN=$REAL
DIV3RSA_NUCLEI_NODE_BIN=$NODE_BIN
DIV3RSA_NUCLEI_PROXY_SCRIPT=$RUNTIME_ROOT/nuclei-scope-proxy.mjs
DIV3RSA_NUCLEI_TEMPLATE_HTTP_ROOT=$SNAPSHOT_ROOT/current/http
DIV3RSA_NUCLEI_READINESS_TEMPLATE=$READINESS_ROOT/div3rsa-readiness.yaml
DIV3RSA_NUCLEI_CLI_HOME=$CLI_HOME
DIV3RSA_NUCLEI_TEST_TARGET=http://$TEST_IP:$TEST_PORT/
EOF
chown root:div3rsa-security "$CONFIG_FILE"
chmod 0640 "$CONFIG_FILE"

install -o root -g root -m 0755 \
  "$SOURCE_ROOT/infra/runtime/security-assets/nuclei-wrapper.sh" \
  "$TOOLS_ROOT/bin/nuclei"
chown root:root "$TOOLS_ROOT/bin/nuclei" "$TOOLS_ROOT/bin/nuclei-real"

# Verify immutable wrapper policy without making a network request.
bash -n "$TOOLS_ROOT/bin/nuclei" || fatal "Nuclei wrapper syntax invalid"
grep -Fq -- '-proxy-internal' "$TOOLS_ROOT/bin/nuclei" || fatal "Nuclei wrapper missing proxy-internal enforcement"
grep -Fq -- '-type http' "$TOOLS_ROOT/bin/nuclei" || fatal "Nuclei wrapper missing HTTP-only enforcement"
grep -Fq -- 'nuclei-scope-proxy.mjs' "$TOOLS_ROOT/bin/nuclei" || fatal "Nuclei wrapper missing scope proxy"
"$TOOLS_ROOT/bin/nuclei" -version >/dev/null 2>&1 || fatal "wrapped Nuclei version check failed"
log "scoped Nuclei runtime ready with pinned curated template snapshot"
