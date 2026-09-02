#!/usr/bin/env bash
set -Eeuo pipefail

log() { printf '[security-e2e] %s\n' "$*"; }
fatal() { log "$*" >&2; exit 1; }

PORT="${DIV3RSA_SECURITY_EXECUTOR_PORT:-7319}"
BASE_URL="${DIV3RSA_SECURITY_EXECUTOR_URL:-http://127.0.0.1:${PORT}}"
ENV_FILE="${DIV3RSA_SECURITY_ENV_FILE:-/etc/div3rsa/security-executor.env}"
# Vercel project localai-web owns system.div3rsa.com. Keep the production E2E
# passive by default: DNS + HTTP only. Set the variable explicitly to an empty
# string to disable external probing in a non-production/manual environment.
TARGET="${DIV3RSA_SECURITY_E2E_TARGET-https://system.div3rsa.com}"
ACTIVE="${DIV3RSA_SECURITY_E2E_ACTIVE:-0}"
ACTIVE_PORTS="${DIV3RSA_SECURITY_E2E_ACTIVE_PORTS:-80,443,8080,8443}"
TOKEN="${DIV3RSA_SECURITY_EXECUTOR_TOKEN:-}"
NODE_BIN="${DIV3RSA_NODE_BIN:-}"

if [[ -z "${TOKEN}" && -r "${ENV_FILE}" ]]; then
  TOKEN="$(sed -n 's/^DIV3RSA_SECURITY_EXECUTOR_TOKEN=//p' "${ENV_FILE}" | tail -n 1)"
fi
if [[ -z "${NODE_BIN}" && -r "${ENV_FILE}" ]]; then
  NODE_BIN="$(sed -n 's/^DIV3RSA_NODE_BIN=//p' "${ENV_FILE}" | tail -n 1)"
fi
if [[ -z "${NODE_BIN}" ]]; then
  NODE_BIN="$(command -v node || true)"
fi
[[ -n "${TOKEN}" ]] || fatal "executor token unavailable"
command -v curl >/dev/null 2>&1 || fatal "curl required"
[[ -n "${NODE_BIN}" && -x "${NODE_BIN}" ]] || fatal "node required"

health="$(curl --fail --silent --show-error --max-time 3 "${BASE_URL}/health")"
"${NODE_BIN}" -e 'const v=JSON.parse(process.argv[1]); if(v.ok!==true||v.service!=="security-executor") process.exit(1)' "${health}" || fatal "health payload invalid"
log "health gate passed"

unauthorized_status="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 3 -X POST -H 'content-type: application/json' --data '{}' "${BASE_URL}/v1/execute")"
[[ "${unauthorized_status}" == "401" ]] || fatal "unauthorized gate expected 401, got ${unauthorized_status}"
log "authentication denial passed"

blocked_payload='{"runId":"e2e-deny","requestId":"e2e-deny","traceId":"e2e-deny","tool":"http_probe","target":"127.0.0.1","timeoutMs":1000,"executionClass":"passive","scope":{"scopeId":"e2e-deny","allowHosts":[],"allowIpv4Cidrs":["127.0.0.1/32"]},"options":{}}'
blocked_response="$(mktemp)"
trap 'rm -f "${blocked_response:-}"' EXIT
blocked_status="$(curl --silent --output "${blocked_response}" --write-out '%{http_code}' --max-time 3 -X POST -H "authorization: Bearer ${TOKEN}" -H 'content-type: application/json' --data "${blocked_payload}" "${BASE_URL}/v1/execute")"
[[ "${blocked_status}" == "400" ]] || fatal "loopback denial expected 400, got ${blocked_status}"
"${NODE_BIN}" -e 'const fs=require("fs"); const v=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(v.error!=="security_target_blocked") process.exit(1)' "${blocked_response}" || fatal "loopback denial reason mismatch"
log "scope/infrastructure denial passed"

if [[ -z "${TARGET}" ]]; then
  log "controlled positive target explicitly disabled; negative gates complete"
  exit 0
fi

host="$("${NODE_BIN}" -e 'const v=process.argv[1]; try { console.log(new URL(/^https?:\/\//i.test(v)?v:`https://${v}`).hostname) } catch { process.exit(1) }' "${TARGET}")" || fatal "invalid E2E target"
if [[ "${host}" == "127.0.0.1" || "${host}" == "localhost" || "${host}" == *.localhost || "${host}" == *.local ]]; then
  fatal "E2E target must be an explicitly authorized non-loopback target"
fi

scope_json="$("${NODE_BIN}" -e 'const h=process.argv[1]; const ip=/^(?:\d{1,3}\.){3}\d{1,3}$/.test(h); process.stdout.write(JSON.stringify({scopeId:"security-e2e-controlled",allowHosts:ip?[]:[h],allowIpv4Cidrs:ip?[`${h}/32`]:[]}))' "${host}")"

execute_probe() {
  local tool="$1" class="$2" timeout="$3" options="${4:-}" payload response status
  # Avoid `${4:-{}}`: the shell parses the closing brace of the literal object as
  # the parameter-expansion delimiter and leaves a trailing `}`, producing `{}}`.
  # Normalize the optional argument separately so the JSON passed to Node is exact.
  if [[ -z "$options" ]]; then
    options='{}'
  fi
  payload="$("${NODE_BIN}" -e 'const [tool,cls,target,timeout,scope,options]=process.argv.slice(1); process.stdout.write(JSON.stringify({runId:`e2e-${tool}`,requestId:`e2e-${tool}`,traceId:`e2e-${tool}`,tool,target,timeoutMs:Number(timeout),executionClass:cls,scope:JSON.parse(scope),options:JSON.parse(options)}))' "$tool" "$class" "$TARGET" "$timeout" "$scope_json" "$options")"
  response="$(mktemp)"
  status="$(curl --silent --output "$response" --write-out '%{http_code}' --max-time "$(( timeout / 1000 + 5 ))" -X POST -H "authorization: Bearer ${TOKEN}" -H 'content-type: application/json' --data "$payload" "${BASE_URL}/v1/execute")"
  if [[ "$status" != "200" ]]; then
    cat "$response" >&2 || true
    rm -f "$response"
    fatal "${tool} expected HTTP 200, got ${status}"
  fi
  "${NODE_BIN}" -e 'const fs=require("fs"); const v=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(v.ok!==true||typeof v.auditId!=="string"||!v.auditId||typeof v.capability!=="string"||!v.capability||!Array.isArray(v.findings)) process.exit(1)' "$response" || { cat "$response" >&2; rm -f "$response"; fatal "${tool} result contract invalid or probe failed"; }
  rm -f "$response"
  log "${tool} live success passed"
}

execute_probe dns_lookup passive 8000 '{}'
execute_probe http_probe passive 12000 '{}'

if [[ "${ACTIVE}" == "1" ]]; then
  active_options="$("${NODE_BIN}" -e 'const raw=process.argv[1]; const ports=raw.split(",").map(v=>Number(v.trim())).filter(Number.isInteger); if(!ports.length||ports.some(v=>v<1||v>65535)||ports.length>128) process.exit(1); process.stdout.write(JSON.stringify({ports,maxRate:50}))' "$ACTIVE_PORTS")" || fatal "invalid active E2E port list"
  execute_probe port_scan active 15000 "$active_options"
  log "active bounded scan gate passed"
else
  log "active live probe skipped; passive external egress is sufficient for the production network gate"
fi

log "controlled security executor E2E passed for ${host}"
