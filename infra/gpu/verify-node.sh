#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MANIFEST="${DIV3RSA_GPU_MANIFEST:-${ROOT}/infra/gpu/model-manifest.json}"
PROFILES="${DIV3RSA_GPU_HARDWARE_PROFILES:-${ROOT}/infra/gpu/hardware-profiles.json}"
PROFILE="${DIV3RSA_GPU_HARDWARE_PROFILE:-pro6000-96g}"
MODEL_DIR="${DIV3RSA_MODEL_DIR:-/opt/div3rsa/models/qwen3.8-27b-obliterated-v3}"
LLAMA_DIR="${DIV3RSA_LLAMA_CPP_DIR:-/opt/div3rsa/llama.cpp}"
MODEL_BASE_URL="${DIV3RSA_MODEL_BASE_URL:-http://127.0.0.1:${DIV3RSA_MODEL_PORT:-8080}}"

die() { printf '[gpu-node-verify] %s\n' "$*" >&2; exit 1; }
log() { printf '[gpu-node-verify] %s\n' "$*"; }

command -v python3 >/dev/null 2>&1 || die "python3_required"
command -v nvidia-smi >/dev/null 2>&1 || die "nvidia_smi_required"
[[ -f "$MANIFEST" ]] || die "manifest_missing:${MANIFEST}"
[[ -f "$PROFILES" ]] || die "hardware_profiles_missing:${PROFILES}"

readarray -t values < <(python3 - "$MANIFEST" "$PROFILES" "$PROFILE" <<'PY'
import json, sys
manifest=json.load(open(sys.argv[1], encoding='utf-8'))
profiles=json.load(open(sys.argv[2], encoding='utf-8'))
profile=profiles['profiles'].get(sys.argv[3])
if not profile: raise SystemExit('unknown_hardware_profile')
if profile.get('status') != 'production-verified': raise SystemExit('hardware_profile_not_production_verified')
p=manifest['productionProfile']; m=manifest['model']; r=manifest['runtime']
if p['hardwareProfile'] != sys.argv[3]: raise SystemExit('manifest_hardware_profile_mismatch')
print(m['filename']); print(m['sha256']); print(m['bytes']); print(r['revision']); print(p['minVramGb']);
print(p['parallel']); print(p['totalContext']); print(p['contextPerSlot']); print(p['specType']);
print('\t'.join(profile.get('allowedGpuNamePatterns') or []))
PY
) || die "manifest_or_profile_invalid"

MODEL_FILENAME="${values[0]}"
EXPECTED_SHA="${values[1]}"
EXPECTED_BYTES="${values[2]}"
EXPECTED_LLAMA_REVISION="${values[3]}"
MIN_VRAM_GB="${values[4]}"
EXPECTED_PARALLEL="${values[5]}"
EXPECTED_TOTAL_CONTEXT="${values[6]}"
EXPECTED_CONTEXT_PER_SLOT="${values[7]}"
EXPECTED_SPEC_TYPE="${values[8]}"
GPU_PATTERNS="${values[9]}"

GPU_INFO="$(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits | head -n1)"
[[ -n "$GPU_INFO" ]] || die "gpu_not_detected"
GPU_NAME="${GPU_INFO%,*}"
VRAM_MIB="${GPU_INFO##*, }"
[[ "$VRAM_MIB" =~ ^[0-9]+$ ]] || die "gpu_vram_unreadable"
MIN_VRAM_MIB="$(python3 - <<PY
print(int(float('${MIN_VRAM_GB}')*1024))
PY
)"
(( VRAM_MIB >= MIN_VRAM_MIB )) || die "insufficient_vram:${VRAM_MIB}MiB<${MIN_VRAM_MIB}MiB"

IFS=$'\t' read -r -a patterns <<< "$GPU_PATTERNS"
matched=0
for pattern in "${patterns[@]}"; do
  [[ -n "$pattern" && "$GPU_NAME" == *"$pattern"* ]] && matched=1 && break
done
(( matched == 1 )) || die "gpu_model_not_allowed:${GPU_NAME}"

MODEL_PATH="${MODEL_DIR}/${MODEL_FILENAME}"
[[ -f "$MODEL_PATH" ]] || die "model_missing:${MODEL_PATH}"
actual_bytes="$(wc -c < "$MODEL_PATH" | tr -d ' ')"
[[ "$actual_bytes" == "$EXPECTED_BYTES" ]] || die "model_size_mismatch:${actual_bytes}"
actual_sha="$(sha256sum "$MODEL_PATH" | cut -d' ' -f1)"
[[ "$actual_sha" == "$EXPECTED_SHA" ]] || die "model_sha256_mismatch:${actual_sha}"

[[ -d "$LLAMA_DIR/.git" ]] || die "llama_git_checkout_missing"
actual_llama="$(git -C "$LLAMA_DIR" describe --tags --always --exact-match HEAD 2>/dev/null || git -C "$LLAMA_DIR" rev-parse --short HEAD)"
if ! git -C "$LLAMA_DIR" rev-parse --verify --quiet "${EXPECTED_LLAMA_REVISION}^{commit}" >/dev/null; then
  die "expected_llama_revision_unavailable:${EXPECTED_LLAMA_REVISION}"
fi
[[ "$(git -C "$LLAMA_DIR" rev-parse HEAD)" == "$(git -C "$LLAMA_DIR" rev-parse "${EXPECTED_LLAMA_REVISION}^{commit}")" ]] || die "llama_revision_mismatch:${actual_llama}"
[[ -x "$LLAMA_DIR/build/bin/llama-server" ]] || die "llama_server_missing"

curl --fail --silent --show-error --max-time 5 "${MODEL_BASE_URL}/health" >/dev/null || die "model_health_failed"
props="$(curl --fail --silent --show-error --max-time 5 "${MODEL_BASE_URL}/props")" || die "model_props_failed"
NODE_PROPS="$props" python3 - "$EXPECTED_PARALLEL" "$EXPECTED_TOTAL_CONTEXT" "$EXPECTED_CONTEXT_PER_SLOT" "$EXPECTED_SPEC_TYPE" <<'PY' || die "runtime_profile_mismatch"
import json, os, sys
p=json.loads(os.environ['NODE_PROPS'])
parallel=int(sys.argv[1]); total=int(sys.argv[2]); per_slot=int(sys.argv[3]); spec=sys.argv[4]
# llama.cpp versions expose slightly different prop names; accept only explicit evidence.
text=json.dumps(p, sort_keys=True).lower()
checks=[str(parallel) in text, str(total) in text, str(per_slot) in text, spec.lower() in text]
if not all(checks):
    raise SystemExit(1)
PY

log "VERIFIED profile=${PROFILE} gpu=${GPU_NAME} vram_mib=${VRAM_MIB} model_sha=${actual_sha} llama=${EXPECTED_LLAMA_REVISION} p=${EXPECTED_PARALLEL} ctx=${EXPECTED_TOTAL_CONTEXT} spec=${EXPECTED_SPEC_TYPE}"
