#!/usr/bin/env bash
set -Eeuo pipefail

log() { printf '[gpuhub-p8-soak] %s\n' "$*"; }
fatal() { log "$*" >&2; exit 1; }

[[ "${EUID}" -eq 0 ]] || fatal "run as root on the GPUHub host"
[[ "${DIV3RSA_P8_SOAK_CONFIRM_DOWNTIME:-}" == "YES" ]] || fatal "set DIV3RSA_P8_SOAK_CONFIRM_DOWNTIME=YES; the canary temporarily restarts llama.cpp"

ROOT_DIR="${DIV3RSA_LEGACY_ROOT_DIR:-/root/autodl-tmp/localai}"
REPO_DIR="${DIV3RSA_LEGACY_APP_DIR:-${ROOT_DIR}/app}"
ENV_FILE="${DIV3RSA_LEGACY_ENV_FILE:-${ROOT_DIR}/secrets/gpuhub-worker.env}"
LOG_DIR="${DIV3RSA_LEGACY_LOG_DIR:-${ROOT_DIR}/logs}"
SCREEN_NAME="${DIV3RSA_LEGACY_WORKER_SCREEN:-localai-agent}"
NODE_BIN="${DIV3RSA_LEGACY_NODE_BIN:-${ROOT_DIR}/runtime/node-current/bin/node}"
RECOVERY_SCRIPT="${REPO_DIR}/infra/runtime/recover-legacy-gpuhub.sh"
SEARCH_CHECK="${REPO_DIR}/infra/runtime/check-search-capability.sh"
MODEL_PORT="${DIV3RSA_MODEL_PORT:-6006}"
TARGET_PARALLEL=8
CONTEXT_PER_SLOT=32768
TARGET_CONTEXT=$((TARGET_PARALLEL * CONTEXT_PER_SLOT))
SOAK_DURATION="${DIV3RSA_P8_SOAK_DURATION_SECONDS:-300}"
SOAK_CONCURRENCY="${DIV3RSA_P8_SOAK_CONCURRENCY:-6}"
RUN_ID="$(date -u +'%Y%m%dT%H%M%SZ')"
OUT_DIR="${DIV3RSA_P8_SOAK_OUTPUT_DIR:-${LOG_DIR}/p8-soak/${RUN_ID}}"
P8_LOG="$OUT_DIR/llama-p8.log"
GPU_CSV="$OUT_DIR/gpu.csv"
BUNDLE_JSON="$OUT_DIR/gate-input.json"
GATE_JSON="$OUT_DIR/gate-result.json"
LOAD_PID=""
GPU_PID=""
CURRENT_PID=""
RESTORED=0

[[ -d "$REPO_DIR/.git" ]] || fatal "repository missing: $REPO_DIR"
[[ -f "$ENV_FILE" ]] || fatal "worker env missing: $ENV_FILE"
[[ -f "$RECOVERY_SCRIPT" ]] || fatal "recovery script missing: $RECOVERY_SCRIPT"
[[ -f "$SEARCH_CHECK" ]] || fatal "search capability checker missing: $SEARCH_CHECK"
[[ -x "$NODE_BIN" ]] || fatal "GPUHub Node runtime missing: $NODE_BIN"
command -v nvidia-smi >/dev/null 2>&1 || fatal "nvidia-smi is missing"
command -v screen >/dev/null 2>&1 || fatal "screen is missing"
mkdir -p "$OUT_DIR"
export PATH="$(dirname "$NODE_BIN"):$PATH"

mapfile -t LLAMA_PIDS < <(pgrep -f 'llama-server.*Qwen3\.8-27B-OBLITERATED-Q8_0\.gguf' || true)
[[ "${#LLAMA_PIDS[@]}" -eq 1 ]] || fatal "expected exactly one Qwen llama-server process, found ${#LLAMA_PIDS[@]}"
ORIGINAL_PID="${LLAMA_PIDS[0]}"
CURRENT_PID="$ORIGINAL_PID"
mapfile -d '' -t ORIGINAL_CMD <"/proc/${ORIGINAL_PID}/cmdline"
[[ "${#ORIGINAL_CMD[@]}" -gt 1 ]] || fatal "could not capture llama-server command"

extract_option() {
  local wanted="$1" fallback="$2" i arg
  for ((i=0; i<${#ORIGINAL_CMD[@]}; i++)); do
    arg="${ORIGINAL_CMD[$i]}"
    if [[ "$arg" == "$wanted" && $((i+1)) -lt ${#ORIGINAL_CMD[@]} ]]; then printf '%s' "${ORIGINAL_CMD[$((i+1))]}"; return; fi
    if [[ "$arg" == "$wanted="* ]]; then printf '%s' "${arg#*=}"; return; fi
  done
  printf '%s' "$fallback"
}

ORIGINAL_PARALLEL="$(extract_option --parallel '')"
[[ -n "$ORIGINAL_PARALLEL" ]] || ORIGINAL_PARALLEL="$(extract_option -np 1)"
ORIGINAL_CONTEXT="$(extract_option --ctx-size 32768)"
[[ "$ORIGINAL_PARALLEL" == "1" ]] || fatal "refusing p8 soak unless production starts at parallel=1; found $ORIGINAL_PARALLEL"
[[ "$ORIGINAL_CONTEXT" == "32768" ]] || fatal "refusing p8 soak unless production starts at ctx=32768; found $ORIGINAL_CONTEXT"

for arg in "${ORIGINAL_CMD[@]}"; do
  [[ "$arg" != "--kv-unified" && "$arg" != --kv-unified=* ]] || fatal "p8 soak assumes non-unified KV; production uses --kv-unified"
done

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
API_KEY="${DIV3RSA_INFERENCE_API_KEY:-${QWEN_INFERENCE_API_KEY:-}}"
if [[ -z "$API_KEY" ]]; then
  API_KEY_FILE="$(extract_option --api-key-file '')"
  [[ -n "$API_KEY_FILE" && -r "$API_KEY_FILE" ]] || fatal "inference API key unavailable"
  API_KEY="$(head -n1 "$API_KEY_FILE")"
fi
[[ -n "$API_KEY" ]] || fatal "inference API key is empty"

health() { curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:${MODEL_PORT}/health" >/dev/null; }
search_health() { bash "$SEARCH_CHECK" "http://127.0.0.1:8890" >/dev/null; }
worker_health() { screen -list | grep -F ".${SCREEN_NAME}" >/dev/null; }

stop_background() {
  if [[ -n "${LOAD_PID:-}" ]] && kill -0 "$LOAD_PID" 2>/dev/null; then kill -TERM "$LOAD_PID" 2>/dev/null || true; wait "$LOAD_PID" 2>/dev/null || true; fi
  LOAD_PID=""
  if [[ -n "${GPU_PID:-}" ]] && kill -0 "$GPU_PID" 2>/dev/null; then kill -TERM "$GPU_PID" 2>/dev/null || true; wait "$GPU_PID" 2>/dev/null || true; fi
  GPU_PID=""
}

stop_model() {
  local pid="${CURRENT_PID:-}"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null || true
    for _ in {1..60}; do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
    if kill -0 "$pid" 2>/dev/null; then kill -KILL "$pid" 2>/dev/null || true; fi
    wait "$pid" 2>/dev/null || true
  fi
  CURRENT_PID=""
}

start_worker_for_parallel() {
  local parallel="$1"
  screen -S "$SCREEN_NAME" -X quit >/dev/null 2>&1 || true
  screen -dmS "$SCREEN_NAME" bash -lc "
    set -Eeuo pipefail
    export PATH='$(dirname "$NODE_BIN")':\$PATH
    set -a
    source '$ENV_FILE'
    set +a
    export DIV3RSA_MODEL_PARALLEL='$parallel'
    export DIV3RSA_MODEL_CONTEXT_SIZE='$CONTEXT_PER_SLOT'
    cd '$REPO_DIR'
    exec node --experimental-transform-types --import ./infra/runpod/native-typescript-register.mjs services/agent-worker/src/main.ts >>'$LOG_DIR/agent-worker.log' 2>&1
  "
  sleep 3
  worker_health || fatal "agent worker failed to start for parallel=$parallel"
}

command_with_p8() {
  local i arg found_parallel=0 found_ctx=0
  P8_CMD=()
  for ((i=0; i<${#ORIGINAL_CMD[@]}; i++)); do
    arg="${ORIGINAL_CMD[$i]}"
    if [[ "$arg" == "--parallel" || "$arg" == "-np" ]]; then P8_CMD+=("--parallel" "$TARGET_PARALLEL"); found_parallel=1; ((i+=1)); continue; fi
    if [[ "$arg" == --parallel=* || "$arg" == -np=* ]]; then P8_CMD+=("--parallel" "$TARGET_PARALLEL"); found_parallel=1; continue; fi
    if [[ "$arg" == "--ctx-size" || "$arg" == "-c" ]]; then P8_CMD+=("--ctx-size" "$TARGET_CONTEXT"); found_ctx=1; ((i+=1)); continue; fi
    if [[ "$arg" == --ctx-size=* || "$arg" == -c=* ]]; then P8_CMD+=("--ctx-size" "$TARGET_CONTEXT"); found_ctx=1; continue; fi
    P8_CMD+=("$arg")
  done
  [[ "$found_parallel" -eq 1 ]] || P8_CMD+=("--parallel" "$TARGET_PARALLEL")
  [[ "$found_ctx" -eq 1 ]] || P8_CMD+=("--ctx-size" "$TARGET_CONTEXT")
}

verify_p8_context() {
  local props reported
  props="$(curl --fail --silent --show-error --max-time 5 -H "Authorization: Bearer ${API_KEY}" "http://127.0.0.1:${MODEL_PORT}/props")"
  reported="$(printf '%s' "$props" | "$NODE_BIN" --input-type=module -e 'import { readFileSync } from "node:fs"; const body=JSON.parse(readFileSync(0,"utf8")); const value=body?.default_generation_settings?.n_ctx; if(Number.isInteger(value)) process.stdout.write(String(value));')"
  [[ "$reported" =~ ^[0-9]+$ && "$reported" -ge "$CONTEXT_PER_SLOT" ]] || fatal "p8 runtime did not preserve ${CONTEXT_PER_SLOT} context per slot; reported=$reported"
  printf 'parallel=%s\ntotal_context=%s\nreported_default_n_ctx=%s\n' "$TARGET_PARALLEL" "$TARGET_CONTEXT" "$reported" >"$OUT_DIR/p8-runtime.txt"
}

restore_original() {
  [[ "$RESTORED" -eq 0 ]] || return 0
  log "restoring p1/32768 production baseline"
  stop_background
  screen -S "$SCREEN_NAME" -X quit >/dev/null 2>&1 || true
  stop_model

  local recovery_status=0
  DIV3RSA_MODEL_PARALLEL=1 \
  DIV3RSA_MODEL_CONTEXT_SIZE=32768 \
  DIV3RSA_MODEL_PORT="$MODEL_PORT" \
  DIV3RSA_LEGACY_ROOT_DIR="$ROOT_DIR" \
  DIV3RSA_LEGACY_APP_DIR="$REPO_DIR" \
  DIV3RSA_LEGACY_ENV_FILE="$ENV_FILE" \
  DIV3RSA_LEGACY_LOG_DIR="$LOG_DIR" \
    bash "$RECOVERY_SCRIPT" || recovery_status=$?
  [[ "$recovery_status" -eq 0 ]] || return "$recovery_status"

  mapfile -t restored_pids < <(pgrep -f 'llama-server.*Qwen3\.8-27B-OBLITERATED-Q8_0\.gguf' || true)
  [[ "${#restored_pids[@]}" -eq 1 ]] || return 1
  CURRENT_PID="${restored_pids[0]}"
  local cmdline
  cmdline="$(tr '\0' ' ' <"/proc/${CURRENT_PID}/cmdline")"
  [[ "$cmdline" =~ --parallel[=\ ]+1 ]] || return 1
  [[ "$cmdline" =~ --ctx-size[=\ ]+32768 ]] || return 1
  health || return 1
  worker_health || return 1
  search_health || return 1
  RESTORED=1
  return 0
}

on_exit() {
  local status=$?
  trap - EXIT TERM INT
  if ! restore_original; then
    log "CRITICAL: automatic restore to p1/32768 failed"
    exit 1
  fi
  exit "$status"
}
trap on_exit EXIT TERM INT

health || fatal "p1 model unhealthy before p8 soak"
worker_health || fatal "worker unhealthy before p8 soak"
search_health || fatal "search unhealthy before p8 soak"

log "transitioning reversible canary from p1/32768 to p8/262144"
screen -S "$SCREEN_NAME" -X quit >/dev/null 2>&1 || true
stop_model
command_with_p8
nohup "${P8_CMD[@]}" </dev/null >>"$P8_LOG" 2>&1 &
CURRENT_PID=$!
deadline=$((SECONDS + 900))
until health; do
  kill -0 "$CURRENT_PID" 2>/dev/null || fatal "p8 llama-server exited during startup; see $P8_LOG"
  (( SECONDS < deadline )) || fatal "p8 health timeout; see $P8_LOG"
  sleep 2
done
verify_p8_context
search_health || fatal "search unhealthy after p8 transition"
start_worker_for_parallel 8

export DIV3RSA_REPOSITORY_ROOT="$REPO_DIR"
export DIV3RSA_EVAL_COMMIT_SHA="$(git -C "$REPO_DIR" rev-parse HEAD)"
export DIV3RSA_MODEL_PARALLEL=8
export DIV3RSA_MODEL_CONTEXT_SIZE=32768
export DIV3RSA_EVAL_MIN_PASS_RATE=1
export DIV3RSA_INFERENCE_BASE_URL="http://127.0.0.1:${MODEL_PORT}/v1"
export QWEN_INFERENCE_BASE_URL="$DIV3RSA_INFERENCE_BASE_URL"
export DIV3RSA_INFERENCE_API_KEY="$API_KEY"

run_eval() {
  local name="$1"
  export DIV3RSA_EVAL_OUTPUT="$OUT_DIR/eval-${name}.json"
  log "running full agent eval: $name"
  "$NODE_BIN" --experimental-transform-types --import ./infra/runpod/native-typescript-register.mjs scripts/eval_agent_runtime.ts \
    >"$OUT_DIR/eval-${name}.stdout.json" 2>"$OUT_DIR/eval-${name}.stderr.log"
}

run_eval pre

log "starting GPU telemetry and ${SOAK_DURATION}s load at concurrency=${SOAK_CONCURRENCY}"
nvidia-smi --query-gpu=timestamp,name,memory.total,memory.used,utilization.gpu,utilization.memory --format=csv,nounits -l 2 >"$GPU_CSV" 2>&1 &
GPU_PID=$!
export DIV3RSA_SOAK_DURATION_SECONDS="$SOAK_DURATION"
export DIV3RSA_SOAK_CONCURRENCY="$SOAK_CONCURRENCY"
export DIV3RSA_SOAK_OUTPUT="$OUT_DIR/load.json"
"$NODE_BIN" scripts/soak_model_concurrency.mjs >"$OUT_DIR/load.stdout.json" 2>"$OUT_DIR/load.stderr.log" &
LOAD_PID=$!
sleep 10
run_eval loaded
wait "$LOAD_PID"
LOAD_PID=""
run_eval post
stop_background

OOM_INDICATORS=0
if grep -Eiq 'out of memory|cuda error|ggml_assert|segmentation fault' "$P8_LOG"; then OOM_INDICATORS=1; fi

GPU_RATIO="$(python3 - "$GPU_CSV" <<'PY'
import csv, sys
rows=[]
with open(sys.argv[1], newline='', encoding='utf-8', errors='ignore') as f:
    for row in csv.reader(f):
        if len(row) < 4 or row[0].strip().lower() == 'timestamp':
            continue
        try:
            total=float(row[2].strip()); used=float(row[3].strip())
        except ValueError:
            continue
        if total > 0: rows.append(used/total)
print(f"{max(rows) if rows else 1.0:.6f}")
PY
)"

log "restoring p1 baseline before promotion decision"
restore_original || fatal "failed to restore exact p1/32768 baseline"
trap - EXIT TERM INT

RESTORED_CMD="$(tr '\0' ' ' <"/proc/${CURRENT_PID}/cmdline")"
RESTORE_MODEL_HEALTH=false; health && RESTORE_MODEL_HEALTH=true
RESTORE_WORKER_HEALTH=false; worker_health && RESTORE_WORKER_HEALTH=true
RESTORE_SEARCH_HEALTH=false; search_health && RESTORE_SEARCH_HEALTH=true

python3 - "$OUT_DIR" "$BUNDLE_JSON" "$GPU_RATIO" "$OOM_INDICATORS" "$RESTORE_MODEL_HEALTH" "$RESTORE_WORKER_HEALTH" "$RESTORE_SEARCH_HEALTH" "$RESTORED_CMD" <<'PY'
import json, os, re, sys
from pathlib import Path
out=Path(sys.argv[1])
cmd=sys.argv[8]
parallel=re.search(r'--parallel(?:=|\s+)(\d+)', cmd)
ctx=re.search(r'--ctx-size(?:=|\s+)(\d+)', cmd)
with (out/'load.json').open() as f: load=json.load(f)
bundle={
  'evaluations': {name: json.load((out/f'eval-{name}.json').open()) for name in ('pre','loaded','post')},
  'soak': {
    'summary': load.get('summary', {}),
    'healthFailures': load.get('healthFailures', 0),
    'oomIndicators': int(sys.argv[4])
  },
  'gpu': {'maxVramUsageRatio': float(sys.argv[3])},
  'restored': {
    'healthy': sys.argv[5] == 'true',
    'workerHealthy': sys.argv[6] == 'true',
    'searchHealthy': sys.argv[7] == 'true',
    'parallel': int(parallel.group(1)) if parallel else None,
    'contextSize': int(ctx.group(1)) if ctx else None
  },
  'thresholds': {
    'minRequests': int(os.environ.get('DIV3RSA_P8_GATE_MIN_REQUESTS','24')),
    'maxErrors': int(os.environ.get('DIV3RSA_P8_GATE_MAX_ERRORS','0')),
    'maxTtftP95Ms': int(os.environ.get('DIV3RSA_P8_GATE_MAX_TTFT_P95_MS','10000')),
    'maxTotalP95Ms': int(os.environ.get('DIV3RSA_P8_GATE_MAX_TOTAL_P95_MS','20000')),
    'maxVramUsageRatio': float(os.environ.get('DIV3RSA_P8_GATE_MAX_VRAM_RATIO','0.94'))
  }
}
Path(sys.argv[2]).write_text(json.dumps(bundle, indent=2)+'\n')
PY

set +e
"$NODE_BIN" scripts/p8_soak_gate.mjs "$BUNDLE_JSON" >"$GATE_JSON"
GATE_STATUS=$?
set -e
cat "$GATE_JSON"
python3 - "$BUNDLE_JSON" <<'PY'
import json, sys
b=json.load(open(sys.argv[1]))
print('[gpuhub-p8-soak] evidence summary')
for name, result in b['evaluations'].items():
    print(f"  eval_{name}: allowed={result.get('allowed')} passed={result.get('passed')}/{result.get('cases')} oracle_failures={result.get('liveOracleFailures')}")
s=b['soak']['summary']
print(f"  load: requests={s.get('requests')} errors={s.get('errors')} ttft_p95={s.get('ttftMs',{}).get('p95')} total_p95={s.get('totalMs',{}).get('p95')} agg_tok_s={s.get('aggregateOutputTokensPerSecond')}")
print(f"  health_failures={b['soak']['healthFailures']} oom_indicators={b['soak']['oomIndicators']} max_vram_ratio={b['gpu']['maxVramUsageRatio']}")
print(f"  restored={b['restored']}")
PY

[[ "$GATE_STATUS" -eq 0 ]] || fatal "p8 soak gate rejected candidate; evidence=$OUT_DIR"
log "p8 soak candidate passed; p1/32768 remains active and no promotion was performed"
log "evidence=$OUT_DIR"
