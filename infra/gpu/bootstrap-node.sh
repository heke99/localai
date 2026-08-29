#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MANIFEST="${DIV3RSA_GPU_MANIFEST:-${ROOT}/infra/gpu/model-manifest.json}"
PROFILE="${DIV3RSA_GPU_HARDWARE_PROFILE:-pro6000-96g}"
RUNTIME_ROOT="${DIV3RSA_RUNTIME_ROOT_DIR:-/opt/div3rsa}"
RUNTIME_REPO="${DIV3RSA_REPO_DIR:-${RUNTIME_ROOT}/localai}"
RUNTIME_ENV="${DIV3RSA_RUNTIME_STATE_DIR:-/etc/div3rsa}/runtime.env"

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
export DIV3RSA_RUNTIME_ROLE=inference
export DIV3RSA_GPUHUB_PRODUCTION_PARALLEL="${manifest_values[2]}"
export DIV3RSA_GPUHUB_PRODUCTION_TOTAL_CONTEXT="${manifest_values[3]}"
export DIV3RSA_GPUHUB_PRODUCTION_CONTEXT_PER_SLOT="${manifest_values[4]}"
export DIV3RSA_GPUHUB_PRODUCTION_SPEC_TYPE="${manifest_values[5]}"

command -v nvidia-smi >/dev/null 2>&1 || die "nvidia_smi_required_before_bootstrap"
log "preflight profile=${PROFILE} role=inference git=${DIV3RSA_RUNTIME_GIT_REF} llama=${DIV3RSA_LLAMA_CPP_REVISION}"

# The provider-neutral installer now sees role=inference before it creates or
# starts systemd. A blank GPU therefore never starts the queue/conversation
# worker, even briefly: its first service process is llama.cpp + registrar.
bash "${ROOT}/infra/runtime/bootstrap-host.sh"

[[ -f "$RUNTIME_ENV" ]] || die "runtime_environment_missing:${RUNTIME_ENV}"
[[ -f "$RUNTIME_REPO/infra/gpu/start-inference-node.sh" ]] || die "inference_start_script_missing"
systemctl cat div3rsa-runtime | grep -F 'start-inference-node.sh' >/dev/null || die "runtime_service_not_inference_only"
systemctl cat div3rsa-runtime | grep -F 'DIV3RSA_RUNTIME_ROLE=inference' >/dev/null || die "runtime_service_role_not_inference"
if systemctl cat div3rsa-runtime | grep -F 'infra/runtime/start-production.sh' >/dev/null; then
  die "combined_runtime_start_path_present"
fi

# A machine that merely started is not equivalent to production. It must prove
# hardware, model digest, llama.cpp revision and the tracked p8 runtime profile.
deadline=$((SECONDS + ${DIV3RSA_MODEL_BOOT_TIMEOUT_SECONDS:-900}))
until bash "$RUNTIME_REPO/infra/gpu/verify-node.sh"; do
  (( SECONDS < deadline )) || die "inference_only_node_verification_timeout"
  sleep 3
done

if [[ "${DIV3RSA_GPU_SKIP_PRODUCTION_EVAL:-0}" != "1" ]]; then
  [[ -f "${RUNTIME_REPO}/scripts/eval_agent_runtime.ts" ]] || die "production_eval_script_missing"
  log "running authoritative 8/8 agent eval before READY promotion"
  set -a
  # shellcheck disable=SC1090
  source "$RUNTIME_ENV"
  set +a
  export DIV3RSA_REPOSITORY_ROOT="$RUNTIME_REPO"
  export DIV3RSA_EVAL_MIN_PASS_RATE=1
  eval_output="$(mktemp)"
  trap 'rm -f "$eval_output"' EXIT
  (cd "$RUNTIME_REPO" && node --experimental-transform-types \
    --import ./infra/runpod/native-typescript-register.mjs \
    scripts/eval_agent_runtime.ts >"$eval_output") || die "production_eval_failed"
  GPU_BOOTSTRAP_EVAL="$(cat "$eval_output")" python3 - <<'PY' || die "production_eval_gate_blocked"
import json, os
raw=os.environ['GPU_BOOTSTRAP_EVAL']
start=raw.find('{')
if start < 0: raise SystemExit(1)
data=json.loads(raw[start:])
if data.get('cases') != 8: raise SystemExit(1)
if data.get('passed') != 8: raise SystemExit(1)
if data.get('passRate') != 1: raise SystemExit(1)
if data.get('allowed') is not True: raise SystemExit(1)
if data.get('liveOracleFailures') != []: raise SystemExit(1)
PY
  rm -f "$eval_output"
  trap - EXIT
fi

log "BOOTSTRAP_VERIFIED inference-only node satisfies div3rsa-gpu-node-v2"
