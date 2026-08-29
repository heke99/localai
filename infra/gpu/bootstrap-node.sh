#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MANIFEST="${DIV3RSA_GPU_MANIFEST:-${ROOT}/infra/gpu/model-manifest.json}"
PROFILE="${DIV3RSA_GPU_HARDWARE_PROFILE:-pro6000-96g}"

die() { printf '[gpu-node-bootstrap] %s\n' "$*" >&2; exit 1; }
log() { printf '[gpu-node-bootstrap] %s\n' "$*"; }

[[ -f "$MANIFEST" ]] || die "manifest_missing"
[[ -n "${DIV3RSA_RUNTIME_GIT_REF:-}" ]] || die "DIV3RSA_RUNTIME_GIT_REF_exact_sha_required"
[[ "$DIV3RSA_RUNTIME_GIT_REF" =~ ^[0-9a-fA-F]{40}$ ]] || die "DIV3RSA_RUNTIME_GIT_REF_must_be_exact_40_hex_sha"

readarray -t manifest_values < <(python3 - "$MANIFEST" <<'PY'
import json,sys
m=json.load(open(sys.argv[1], encoding='utf-8'))
print(m['runtime']['revision'])
print(m['runtime']['nodeVersion'])
print(m['productionProfile']['parallel'])
print(m['productionProfile']['totalContext'])
print(m['productionProfile']['contextPerSlot'])
print(m['productionProfile']['specType'])
PY
) || die "invalid_manifest"

export DIV3RSA_LLAMA_CPP_REVISION="${manifest_values[0]}"
export DIV3RSA_NODE_VERSION="${manifest_values[1]}"
export DIV3RSA_RUNTIME_PROFILE="$PROFILE"
export DIV3RSA_GPUHUB_PRODUCTION_PARALLEL="${manifest_values[2]}"
export DIV3RSA_GPUHUB_PRODUCTION_TOTAL_CONTEXT="${manifest_values[3]}"
export DIV3RSA_GPUHUB_PRODUCTION_CONTEXT_PER_SLOT="${manifest_values[4]}"
export DIV3RSA_GPUHUB_PRODUCTION_SPEC_TYPE="${manifest_values[5]}"

command -v nvidia-smi >/dev/null 2>&1 || die "nvidia_smi_required_before_bootstrap"
log "preflight hardware profile=${PROFILE} git=${DIV3RSA_RUNTIME_GIT_REF} llama=${DIV3RSA_LLAMA_CPP_REVISION}"

# The provider-neutral bootstrap already handles exact-revision repository checkout,
# pinned Node, pinned llama.cpp build, checksum-pinned model retrieval, TLS ingress,
# systemd service installation and runtime self-registration. This wrapper makes the
# manifest the source of truth instead of duplicating that implementation.
bash "${ROOT}/infra/runtime/bootstrap-host.sh"

# A node may be installed but it is not production-equivalent until it proves the
# immutable artifact and runtime profile. Registration/routing remains fail-closed.
bash "${ROOT}/infra/gpu/verify-node.sh"

if [[ "${DIV3RSA_GPU_SKIP_PRODUCTION_EVAL:-0}" != "1" ]]; then
  [[ -f "${ROOT}/scripts/eval_agent_production.mjs" ]] || die "production_eval_script_missing"
  log "running production agent eval before READY promotion"
  eval_json="$(cd "$ROOT" && node scripts/eval_agent_production.mjs --json)" || die "production_eval_failed"
  GPU_BOOTSTRAP_EVAL="$eval_json" python3 - <<'PY' || exit 1
import json, os
raw=os.environ['GPU_BOOTSTRAP_EVAL']
start=raw.find('{')
if start < 0: raise SystemExit('production_eval_json_missing')
data=json.loads(raw[start:])
if data.get('passed') != 8 or data.get('passRate') != 1 or data.get('allowed') is not True or data.get('liveOracleFailures') != []:
    raise SystemExit('production_eval_gate_blocked')
PY
fi

log "BOOTSTRAP_VERIFIED node satisfies div3rsa-gpu-node-v2; READY registration may proceed"
