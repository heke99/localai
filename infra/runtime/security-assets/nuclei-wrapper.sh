#!/usr/bin/env bash
set -Eeuo pipefail

BIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOLS_ROOT="$(cd "$BIN_DIR/.." && pwd)"
CONFIG_FILE="${DIV3RSA_NUCLEI_RUNTIME_CONFIG:-${TOOLS_ROOT}/runtime/nuclei-runtime.env}"
[[ -r "$CONFIG_FILE" ]] || { echo "nuclei wrapper: runtime config unavailable" >&2; exit 78; }
# shellcheck disable=SC1090
source "$CONFIG_FILE"

REAL="${DIV3RSA_NUCLEI_REAL_BIN:-${TOOLS_ROOT}/bin/nuclei-real}"
NODE="${DIV3RSA_NUCLEI_NODE_BIN:-${TOOLS_ROOT}/node/bin/node}"
PROXY_SCRIPT="${DIV3RSA_NUCLEI_PROXY_SCRIPT:-${TOOLS_ROOT}/runtime/nuclei-scope-proxy.mjs}"
SNAPSHOT="${DIV3RSA_NUCLEI_TEMPLATE_HTTP_ROOT:-${TOOLS_ROOT}/nuclei-template-snapshots/current/http}"
READINESS_TEMPLATE="${DIV3RSA_NUCLEI_READINESS_TEMPLATE:-${TOOLS_ROOT}/nuclei-readiness/div3rsa-readiness.yaml}"
CLI_HOME="${DIV3RSA_NUCLEI_CLI_HOME:-${TOOLS_ROOT}/runtime-home}"
TEST_TARGET="${DIV3RSA_NUCLEI_TEST_TARGET:-http://127.0.0.1:18080/}"

[[ -x "$REAL" ]] || { echo "nuclei wrapper: real binary unavailable" >&2; exit 78; }
[[ -x "$NODE" ]] || { echo "nuclei wrapper: node runtime unavailable" >&2; exit 78; }
[[ -r "$PROXY_SCRIPT" ]] || { echo "nuclei wrapper: scope proxy unavailable" >&2; exit 78; }

export HOME="$CLI_HOME"
export XDG_CONFIG_HOME="$CLI_HOME/.config"
export XDG_CACHE_HOME="$CLI_HOME/.cache"
export TMPDIR="$CLI_HOME/tmp"

for arg in "$@"; do
  case "$arg" in
    -version|-h|-help|--help) exec "$REAL" "$@" ;;
  esac
done

input=("$@")
target=""
virtual_host=""
for ((i=0; i<${#input[@]}; i++)); do
  case "${input[i]}" in
    -u|-target)
      (( i + 1 < ${#input[@]} )) || { echo "nuclei wrapper: target value missing" >&2; exit 2; }
      target="${input[i+1]}"
      ;;
    -H|-header)
      (( i + 1 < ${#input[@]} )) || { echo "nuclei wrapper: header value missing" >&2; exit 2; }
      header="${input[i+1]}"
      if [[ "${header,,}" == host:* ]]; then
        virtual_host="${header#*:}"
        virtual_host="${virtual_host# }"
      fi
      ;;
  esac
done

# Administrative validation/version use may intentionally omit a target. The
# security executor never does; preserve the real CLI for those maintenance uses.
if [[ -z "$target" ]]; then exec "$REAL" "${input[@]}"; fi

readiness=false
[[ "$target" == "$TEST_TARGET" ]] && readiness=true

# The executor owns target/scope/rate arguments. Strip any future conflicting
# template/proxy/protocol selectors before adding the immutable runtime policy.
filtered=()
for ((i=0; i<${#input[@]}; i++)); do
  arg="${input[i]}"
  case "$arg" in
    -p|-proxy|-t|-templates|-turl|-template-url|-w|-workflows|-wurl|-workflow-url|-pt|-type|-ept|-exclude-type)
      (( i + 1 < ${#input[@]} )) && ((i+=1))
      continue
      ;;
    -pi|-proxy-internal|-as|-automatic-scan)
      continue
      ;;
    -restrict-local-network-access)
      if [[ "$readiness" == "true" ]]; then continue; fi
      ;;
  esac
  filtered+=("$arg")
done

ready_file="$(mktemp "$CLI_HOME/tmp/nuclei-proxy.XXXXXX.ready")"
rm -f "$ready_file"
proxy_stderr="$(mktemp "$CLI_HOME/tmp/nuclei-proxy.XXXXXX.stderr")"
proxy_pid=""
cleanup_proxy() {
  if [[ -n "$proxy_pid" ]]; then
    kill "$proxy_pid" >/dev/null 2>&1 || true
    wait "$proxy_pid" >/dev/null 2>&1 || true
  fi
  rm -f "$ready_file" "$proxy_stderr"
}
trap cleanup_proxy EXIT INT TERM

"$NODE" "$PROXY_SCRIPT" \
  --target-url "$target" \
  --virtual-host "$virtual_host" \
  --ready-file "$ready_file" \
  >/dev/null 2>"$proxy_stderr" &
proxy_pid=$!
for _ in {1..80}; do
  kill -0 "$proxy_pid" >/dev/null 2>&1 || { cat "$proxy_stderr" >&2 || true; exit 70; }
  [[ -s "$ready_file" ]] && break
  sleep 0.05
done
[[ -s "$ready_file" ]] || { echo "nuclei wrapper: scope proxy failed readiness" >&2; cat "$proxy_stderr" >&2 || true; exit 70; }
proxy_url="$("$NODE" -e 'const fs=require("fs");const v=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(v.url))process.exit(1);process.stdout.write(v.url)' "$ready_file")"

common=(
  -type http
  -proxy "$proxy_url"
  -proxy-internal
  -no-interactsh
  -disable-update-check
  -disable-redirects
  -exclude-tags dos,fuzz,intrusive,headless,credential-stuffing,token-spray
)

set +e
if [[ "$readiness" == "true" ]]; then
  "$REAL" -t "$READINESS_TEMPLATE" "${common[@]}" "${filtered[@]}"
  status=$?
else
  for dir in cves exposed-panels exposures misconfiguration technologies vulnerabilities; do
    [[ -d "$SNAPSHOT/$dir" ]] || { echo "nuclei wrapper: curated template directory missing: $dir" >&2; exit 78; }
  done
  "$REAL" \
    -automatic-scan \
    -t "$SNAPSHOT/cves" \
    -t "$SNAPSHOT/exposed-panels" \
    -t "$SNAPSHOT/exposures" \
    -t "$SNAPSHOT/misconfiguration" \
    -t "$SNAPSHOT/technologies" \
    -t "$SNAPSHOT/vulnerabilities" \
    "${common[@]}" "${filtered[@]}"
  status=$?
fi
set -e
exit "$status"
