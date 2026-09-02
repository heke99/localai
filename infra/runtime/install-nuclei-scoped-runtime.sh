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

[[ "${EUID}" -eq 0 ]] || fatal "run as root on the runtime host"
[[ -x "$NODE_BIN" ]] || fatal "isolated Node runtime missing: $NODE_BIN"
[[ -f "$SOURCE_ROOT/infra/runtime/security-assets/nuclei-scope-proxy.mjs" ]] || fatal "Nuclei scope proxy source missing"
[[ -f "$SOURCE_ROOT/infra/runtime/security-assets/nuclei-readiness.yaml" ]] || fatal "Nuclei readiness template missing"
[[ -x "$SOURCE_ROOT/infra/runtime/provision-nuclei-template-snapshot.sh" || -f "$SOURCE_ROOT/infra/runtime/provision-nuclei-template-snapshot.sh" ]] || fatal "Nuclei snapshot provisioner missing"

DIV3RSA_SECURITY_TOOLS_ROOT="$TOOLS_ROOT" \
  bash "$SOURCE_ROOT/infra/runtime/provision-nuclei-template-snapshot.sh"

install -d -o root -g div3rsa-security -m 0750 "$RUNTIME_ROOT" "$READINESS_ROOT" "$CLI_HOME" "$CLI_HOME/.config" "$CLI_HOME/.cache" "$CLI_HOME/tmp"
install -o root -g div3rsa-security -m 0640 \
  "$SOURCE_ROOT/infra/runtime/security-assets/nuclei-scope-proxy.mjs" \
  "$RUNTIME_ROOT/nuclei-scope-proxy.mjs"
install -o root -g div3rsa-security -m 0640 \
  "$SOURCE_ROOT/infra/runtime/security-assets/nuclei-readiness.yaml" \
  "$READINESS_ROOT/div3rsa-readiness.yaml"
chown -R div3rsa-security:div3rsa-security "$CLI_HOME"
chmod 0700 "$CLI_HOME" "$CLI_HOME/.config" "$CLI_HOME/.cache" "$CLI_HOME/tmp"

if [[ ! -x "$TOOLS_ROOT/bin/nuclei-real" ]]; then
  [[ -x "$TOOLS_ROOT/bin/nuclei" ]] || fatal "Nuclei binary missing"
  mv "$TOOLS_ROOT/bin/nuclei" "$TOOLS_ROOT/bin/nuclei-real"
fi
REAL="$TOOLS_ROOT/bin/nuclei-real"
[[ -x "$REAL" ]] || fatal "real Nuclei binary unavailable"

for dir in cves exposed-panels exposures misconfiguration technologies vulnerabilities; do
  [[ -d "$SNAPSHOT_ROOT/current/http/$dir" ]] || fatal "curated Nuclei snapshot missing http/$dir"
done

cat > "$TOOLS_ROOT/bin/nuclei" <<EOF
#!/usr/bin/env bash
set -Eeuo pipefail
REAL="$REAL"
NODE="$NODE_BIN"
PROXY_SCRIPT="$RUNTIME_ROOT/nuclei-scope-proxy.mjs"
SNAPSHOT="$SNAPSHOT_ROOT/current/http"
READINESS_TEMPLATE="$READINESS_ROOT/div3rsa-readiness.yaml"
CLI_HOME="$CLI_HOME"
TEST_TARGET="http://$TEST_IP:$TEST_PORT/"
export HOME="\$CLI_HOME"
export XDG_CONFIG_HOME="\$CLI_HOME/.config"
export XDG_CACHE_HOME="\$CLI_HOME/.cache"
export TMPDIR="\$CLI_HOME/tmp"

for arg in "\$@"; do
  case "\$arg" in
    -version|-h|-help|--help) exec "\$REAL" "\$@" ;;
  esac
done

input=("\$@")
target=""
virtual_host=""
for ((i=0; i<\${#input[@]}; i++)); do
  case "\${input[i]}" in
    -u|-target)
      (( i + 1 < \${#input[@]} )) || { echo "nuclei wrapper: target value missing" >&2; exit 2; }
      target="\${input[i+1]}"
      ;;
    -H|-header)
      (( i + 1 < \${#input[@]} )) || { echo "nuclei wrapper: header value missing" >&2; exit 2; }
      header="\${input[i+1]}"
      if [[ "\${header,,}" == host:* ]]; then virtual_host="\${header#*:}"; virtual_host="\${virtual_host# }"; fi
      ;;
  esac
done

# Administrative validation/version use may intentionally omit a target. The
# security executor never does; preserve the real CLI for those maintenance uses.
if [[ -z "\$target" ]]; then exec "\$REAL" "\${input[@]}"; fi

readiness=false
[[ "\$target" == "\$TEST_TARGET" ]] && readiness=true

# The executor owns target/scope/rate arguments. Strip any future conflicting
# template/proxy/protocol selectors before adding the immutable runtime policy.
filtered=()
for ((i=0; i<\${#input[@]}; i++)); do
  arg="\${input[i]}"
  case "\$arg" in
    -p|-proxy|-t|-templates|-turl|-template-url|-w|-workflows|-wurl|-workflow-url|-pt|-type|-ept|-exclude-type)
      (( i + 1 < \${#input[@]} )) && ((i+=1))
      continue
      ;;
    -pi|-proxy-internal|-as|-automatic-scan)
      continue
      ;;
    -restrict-local-network-access)
      if [[ "\$readiness" == "true" ]]; then continue; fi
      ;;
  esac
  filtered+=("\$arg")
done

ready_file="\$(mktemp "\$CLI_HOME/tmp/nuclei-proxy.XXXXXX.ready")"
rm -f "\$ready_file"
proxy_pid=""
cleanup_proxy() {
  if [[ -n "\$proxy_pid" ]]; then kill "\$proxy_pid" >/dev/null 2>&1 || true; wait "\$proxy_pid" >/dev/null 2>&1 || true; fi
  rm -f "\$ready_file"
}
trap cleanup_proxy EXIT INT TERM

"\$NODE" "\$PROXY_SCRIPT" \
  --target-url "\$target" \
  --virtual-host "\$virtual_host" \
  --ready-file "\$ready_file" \
  >/dev/null 2>"\$CLI_HOME/tmp/nuclei-proxy.stderr" &
proxy_pid=\$!
for _ in {1..80}; do
  kill -0 "\$proxy_pid" >/dev/null 2>&1 || { cat "\$CLI_HOME/tmp/nuclei-proxy.stderr" >&2 || true; exit 70; }
  [[ -s "\$ready_file" ]] && break
  sleep 0.05
done
[[ -s "\$ready_file" ]] || { echo "nuclei wrapper: scope proxy failed readiness" >&2; exit 70; }
proxy_url="\$("\$NODE" -e 'const fs=require("fs");const v=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(v.url))process.exit(1);process.stdout.write(v.url)' "\$ready_file")"

common=(
  -type http
  -proxy "\$proxy_url"
  -proxy-internal
  -no-interactsh
  -disable-update-check
  -disable-redirects
  -exclude-tags dos,fuzz,intrusive,headless,credential-stuffing,token-spray
)

set +e
if [[ "\$readiness" == "true" ]]; then
  "\$REAL" -t "\$READINESS_TEMPLATE" "\${common[@]}" "\${filtered[@]}"
  status=\$?
else
  "\$REAL" \
    -automatic-scan \
    -t "\$SNAPSHOT/cves" \
    -t "\$SNAPSHOT/exposed-panels" \
    -t "\$SNAPSHOT/exposures" \
    -t "\$SNAPSHOT/misconfiguration" \
    -t "\$SNAPSHOT/technologies" \
    -t "\$SNAPSHOT/vulnerabilities" \
    "\${common[@]}" "\${filtered[@]}"
  status=\$?
fi
set -e
exit "\$status"
EOF
chmod 0755 "$TOOLS_ROOT/bin/nuclei"
chown root:root "$TOOLS_ROOT/bin/nuclei" "$TOOLS_ROOT/bin/nuclei-real"

# Verify wrapper policy without making a network request.
grep -Fq -- '-proxy-internal' "$TOOLS_ROOT/bin/nuclei" || fatal "Nuclei wrapper missing proxy-internal enforcement"
grep -Fq -- '-type http' "$TOOLS_ROOT/bin/nuclei" || fatal "Nuclei wrapper missing HTTP-only enforcement"
grep -Fq -- 'nuclei-scope-proxy.mjs' "$TOOLS_ROOT/bin/nuclei" || fatal "Nuclei wrapper missing scope proxy"
"$TOOLS_ROOT/bin/nuclei" -version >/dev/null 2>&1 || fatal "wrapped Nuclei version check failed"
log "scoped Nuclei runtime ready with pinned curated template snapshot"
