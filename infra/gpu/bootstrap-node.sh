#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MANIFEST="${DIV3RSA_GPU_MANIFEST:-${ROOT}/infra/gpu/model-manifest.json}"
PROFILE="${DIV3RSA_GPU_HARDWARE_PROFILE:-pro6000-96g}"
RUNTIME_ROOT="${DIV3RSA_RUNTIME_ROOT_DIR:-/opt/div3rsa}"
RUNTIME_REPO="${DIV3RSA_REPO_DIR:-${RUNTIME_ROOT}/localai}"
RUNTIME_ENV="${DIV3RSA_RUNTIME_STATE_DIR:-/etc/div3rsa}/runtime.env"
SYSTEMD_DROPIN="/etc/systemd/system/div3rsa-runtime.service.d/20-inference-only.conf"

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
log "preflight profile=${PROFILE} git=${DIV3RSA_RUNTIME_GIT_REF} llama=${DIV3RSA_LLAMA_CPP_REVISION}"

# Reuse the provider-neutral installer for packages, exact source revision,
# pinned Node/llama.cpp/model artifact, TLS ingress and base systemd service.
bash "${ROOT}/infra/runtime/bootstrap-host.sh"

# Convert the GPU service into inference-only mode. The queue worker and all
# conversational/memory/run state live outside the GPU; only llama.cpp plus a
# tiny route registrar/heartbeat remain here.
[[ -f "$RUNTIME_ENV" ]] || die "runtime_environment_missing:${RUNTIME_ENV}"
[[ -x "$RUNTIME_REPO/infra/gpu/start-inference-node.sh" || -f "$RUNTIME_REPO/infra/gpu/start-inference-node.sh" ]] || die "inference_start_script_missing"
mkdir -p "$(dirname "$SYSTEMD_DROPIN")"
cat > "$SYSTEMD_DROPIN" <<EOF
[Service]
Environment=DIV3RSA_RUNTIME_ROLE=inference
ExecStart=
ExecStart=/bin/bash -lc 'set -a; source ${RUNTIME_ENV}; set +a; export DIV3RSA_RUNTIME_ROLE=inference; exec bash ${RUNTIME_REPO}/infra/gpu/start-inference-node.sh'
EOF
systemctl daemon-reload
systemctl restart div3rsa-runtime

# A machine that merely started is not equivalent to production. It must prove
# hardware, model digest, llama.cpp revision and the tracked p8 runtime profile.
deadline=$((SECONDS + ${DIV3RSA_MODEL_BOOT_TIMEOUT_SECONDS:-900}))
until bash "$RUNTIME_REPO/infra/gpu/verify-node.sh"; do
  (( SECONDS < deadline )) || die "inference_only_node_verification_timeout"
  sleep 3
done

if [[ "${DIV3RSA_GPU_SKIP_PRODUCTION_EVAL:-0}" != "1" ]]; then
  [[ -f "${RUNTIME_REPO}/scripts/eval_agent_production.mjs" ]] || die "production_eval_script_missing"
  log "running production agent eval before READY promotion"
  eval_json="$(cd "$RUNTIME_REPO" && node scripts/eval_agent_production.mjs --json)" || die "production_eval_failed"
  GPU_BOOTSTRAP_EVAL="$eval_json" python3 - <<'PY' || die "production_eval_gate_blocked"
import json, os
raw=os.environ['GPU_BOOTSTRAP_EVAL']
start=raw.find('{')
if start < 0: raise SystemExit(1)
data=json.loads(raw[start:])
if data.get('passed') != 8: raise SystemExit(1)
if data.get('passRate') != 1: raise SystemExit(1)
if data.get('allowed') is not True: raise SystemExit(1)
if data.get('liveOracleFailures') != []: raise SystemExit(1)
PY
fi

log "BOOTSTRAP_VERIFIED inference-only node satisfies div3rsa-gpu-node-v2"
