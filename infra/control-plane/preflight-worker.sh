#!/usr/bin/env bash
set -Eeuo pipefail

fatal(){ printf '[control-plane-preflight] %s\n' "$*" >&2; exit 1; }
log(){ printf '[control-plane-preflight] %s\n' "$*"; }

ROOT=${DIV3RSA_CONTROL_PLANE_ROOT:-/opt/div3rsa/localai}
ENV_FILE=${DIV3RSA_CONTROL_PLANE_ENV_FILE:-$ROOT/secrets/control-plane.env}
ALIAS=${DIV3RSA_CONTROL_PLANE_ALIAS:-general-prod}

[[ -f "$ENV_FILE" ]] || fatal "control-plane environment missing: $ENV_FILE"
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

[[ "${DIV3RSA_INFERENCE_ROUTING_MODE:-}" == "registry" ]] || fatal "registry routing is required"
[[ "${DIV3RSA_RUNTIME_ROLE:-control-plane}" == "control-plane" ]] || fatal "runtime role must be control-plane"
: "${SUPABASE_URL:?SUPABASE_URL required}"
: "${SUPABASE_SECRET_KEY:?SUPABASE_SECRET_KEY required}"
: "${DIV3RSA_INTEGRATION_GATEWAY_URL:?DIV3RSA_INTEGRATION_GATEWAY_URL required}"

systemctl is-active --quiet div3rsa-agent-worker.service || fatal "agent worker service is not active"
if pgrep -af 'llama-server|start-inference-node|inference-node-registrar' >/dev/null 2>&1; then
  fatal "inference process detected on CPU control plane"
fi

routes_file="$(mktemp)"
trap 'rm -f "$routes_file"' EXIT
http_code="$(curl --silent --show-error --output "$routes_file" --write-out '%{http_code}' --max-time 10 \
  -X POST "${SUPABASE_URL%/}/rest/v1/rpc/runtime_resolve_model_routes" \
  -H "apikey: $SUPABASE_SECRET_KEY" \
  -H "Authorization: Bearer $SUPABASE_SECRET_KEY" \
  -H 'Content-Type: application/json' \
  --data "{\"target_alias\":\"$ALIAS\"}")" || fatal "Supabase runtime registry unreachable"
[[ "$http_code" == "200" ]] || { cat "$routes_file" >&2 || true; fatal "runtime registry RPC returned HTTP $http_code"; }

python3 - "$routes_file" <<'PY' || fatal "no fresh READY inference route is available"
import json,sys
rows=json.load(open(sys.argv[1],encoding='utf-8'))
if not isinstance(rows,list) or not rows:
    raise SystemExit(1)
for row in rows:
    if row.get('worker_state') != 'ready':
        raise SystemExit(1)
    endpoint=row.get('endpoint')
    if not isinstance(endpoint,str) or not endpoint.startswith('https://'):
        raise SystemExit(1)
PY

# Reachability only: the internal gateway may reject an unauthenticated probe with
# 400/401/403/405. 5xx, DNS/connect failures and timeouts are not acceptable.
gateway_code="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' --max-time 10 \
  -X OPTIONS "$DIV3RSA_INTEGRATION_GATEWAY_URL")" || fatal "integration gateway unreachable"
case "$gateway_code" in
  200|204|400|401|403|405) ;;
  *) fatal "integration gateway unhealthy HTTP $gateway_code" ;;
esac

journalctl -u div3rsa-agent-worker.service -n 200 --no-pager | grep -F 'inferenceRouting=registry' >/dev/null \
  || fatal "worker startup log does not prove registry routing"

log "READY alias=$ALIAS routing=registry role=control-plane freshRoute=true localInference=false"
