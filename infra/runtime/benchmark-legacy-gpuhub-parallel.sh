#!/usr/bin/env bash
set -Eeuo pipefail

log() { printf '[gpuhub-benchmark] %s\n' "$*"; }
fatal() { log "$*" >&2; exit 1; }

[[ "${EUID}" -eq 0 ]] || fatal "run as root on the GPUHub host"
[[ "${DIV3RSA_BENCHMARK_CONFIRM_DOWNTIME:-}" == "YES" ]] || fatal "set DIV3RSA_BENCHMARK_CONFIRM_DOWNTIME=YES; this benchmark temporarily restarts llama.cpp"

ROOT_DIR="${DIV3RSA_LEGACY_ROOT_DIR:-/root/autodl-tmp/localai}"
REPO_DIR="${DIV3RSA_LEGACY_APP_DIR:-${ROOT_DIR}/app}"
ENV_FILE="${DIV3RSA_LEGACY_ENV_FILE:-${ROOT_DIR}/secrets/gpuhub-worker.env}"
LOG_DIR="${DIV3RSA_LEGACY_LOG_DIR:-${ROOT_DIR}/logs}"
SCREEN_NAME="${DIV3RSA_LEGACY_WORKER_SCREEN:-localai-agent}"
NODE_BIN="${DIV3RSA_LEGACY_NODE_BIN:-${ROOT_DIR}/runtime/node-current/bin/node}"
RECOVERY_SCRIPT="${REPO_DIR}/infra/runtime/recover-legacy-gpuhub.sh"
PROFILES="${DIV3RSA_BENCH_SERVER_PARALLEL:-1,2,4,8}"
CLIENT_MATRIX="${DIV3RSA_BENCH_CONCURRENCY:-1,2,4,8}"
RUN_ID="$(date -u +'%Y%m%dT%H%M%SZ')"
OUT_DIR="${DIV3RSA_BENCH_OUTPUT_DIR:-${LOG_DIR}/benchmarks/${RUN_ID}}"

[[ -d "$REPO_DIR/.git" ]] || fatal "repository missing: $REPO_DIR"
[[ -f "$ENV_FILE" ]] || fatal "worker env missing: $ENV_FILE"
[[ -f "$RECOVERY_SCRIPT" ]] || fatal "recovery script missing: $RECOVERY_SCRIPT"
mkdir -p "$OUT_DIR"

if [[ -x "$NODE_BIN" ]]; then
  export PATH="$(dirname "$NODE_BIN"):$PATH"
elif ! command -v node >/dev/null 2>&1; then
  fatal "Node.js is missing"
fi
command -v nvidia-smi >/dev/null 2>&1 || fatal "nvidia-smi is missing"

mapfile -t LLAMA_PIDS < <(pgrep -f 'llama-server.*Qwen3\.8-27B-OBLITERATED-Q8_0\.gguf' || true)
[[ "${#LLAMA_PIDS[@]}" -eq 1 ]] || fatal "expected exactly one Qwen llama-server process, found ${#LLAMA_PIDS[@]}"
ORIGINAL_PID="${LLAMA_PIDS[0]}"
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

MODEL_PORT="$(extract_option --port 6006)"
ORIGINAL_PARALLEL="$(extract_option --parallel '')"
[[ -n "$ORIGINAL_PARALLEL" ]] || ORIGINAL_PARALLEL="$(extract_option -np 1)"

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
API_KEY="${DIV3RSA_INFERENCE_API_KEY:-${QWEN_INFERENCE_API_KEY:-}}"
if [[ -z "$API_KEY" ]]; then
  API_KEY_FILE="$(extract_option --api-key-file '')"
  [[ -n "$API_KEY_FILE" && -r "$API_KEY_FILE" ]] || fatal "inference API key is unavailable"
  API_KEY="$(head -n1 "$API_KEY_FILE")"
fi
[[ -n "$API_KEY" ]] || fatal "inference API key is empty"

health() { curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:${MODEL_PORT}/health" >/dev/null; }
health || fatal "current Qwen server is not healthy before benchmark"

printf 'run_id=%s\noriginal_pid=%s\noriginal_parallel=%s\nmodel_port=%s\nrepo_commit=%s\n' \
  "$RUN_ID" "$ORIGINAL_PID" "$ORIGINAL_PARALLEL" "$MODEL_PORT" "$(git -C "$REPO_DIR" rev-parse HEAD)" >"$OUT_DIR/manifest.txt"
printf 'original_command=' >>"$OUT_DIR/manifest.txt"
printf '%q ' "${ORIGINAL_CMD[@]}" >>"$OUT_DIR/manifest.txt"
printf '\n' >>"$OUT_DIR/manifest.txt"

CURRENT_PID="$ORIGINAL_PID"
RESTORED=0

stop_model() {
  local pid="${CURRENT_PID:-}"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null || true
    for _ in {1..60}; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.5
    done
    if kill -0 "$pid" 2>/dev/null; then
      kill -KILL "$pid" 2>/dev/null || true
    fi
    wait "$pid" 2>/dev/null || true
  fi
  CURRENT_PID=""
}

command_with_parallel() {
  local profile="$1" i arg found=0
  PROFILE_CMD=()
  for ((i=0; i<${#ORIGINAL_CMD[@]}; i++)); do
    arg="${ORIGINAL_CMD[$i]}"
    if [[ "$arg" == "--parallel" || "$arg" == "-np" ]]; then
      PROFILE_CMD+=("--parallel" "$profile")
      found=1
      ((i+=1))
      continue
    fi
    if [[ "$arg" == --parallel=* || "$arg" == -np=* ]]; then
      PROFILE_CMD+=("--parallel" "$profile")
      found=1
      continue
    fi
    PROFILE_CMD+=("$arg")
  done
  if [[ "$found" -eq 0 ]]; then PROFILE_CMD+=("--parallel" "$profile"); fi
}

start_command() {
  local label="$1"; shift
  local logfile="$OUT_DIR/llama-${label}.log"
  nohup "$@" </dev/null >>"$logfile" 2>&1 &
  CURRENT_PID=$!
  local deadline=$((SECONDS + 900))
  while true; do
    kill -0 "$CURRENT_PID" 2>/dev/null || fatal "llama-server exited during ${label}; see ${logfile}"
    if health; then break; fi
    (( SECONDS < deadline )) || fatal "llama-server health timeout during ${label}; see ${logfile}"
    sleep 2
  done
}

restore_original() {
  [[ "$RESTORED" -eq 0 ]] || return
  RESTORED=1
  log "restoring original production profile parallel=${ORIGINAL_PARALLEL} through recovery runtime"
  stop_model
  DIV3RSA_MODEL_PARALLEL="$ORIGINAL_PARALLEL" \
  DIV3RSA_MODEL_PORT="$MODEL_PORT" \
  DIV3RSA_LEGACY_ROOT_DIR="$ROOT_DIR" \
  DIV3RSA_LEGACY_APP_DIR="$REPO_DIR" \
  DIV3RSA_LEGACY_ENV_FILE="$ENV_FILE" \
  DIV3RSA_LEGACY_LOG_DIR="$LOG_DIR" \
    bash "$RECOVERY_SCRIPT"
  mapfile -t restored_pids < <(pgrep -f 'llama-server.*Qwen3\.8-27B-OBLITERATED-Q8_0\.gguf' || true)
  [[ "${#restored_pids[@]}" -eq 1 ]] || fatal "expected one recovered Qwen process, found ${#restored_pids[@]}"
  CURRENT_PID="${restored_pids[0]}"
  health || fatal "recovered Qwen server failed health check"
  screen -list | grep -F ".${SCREEN_NAME}" >/dev/null || fatal "agent worker missing after recovery"
  log "original production runtime restored and healthy"
}
trap 'status=$?; restore_original || true; exit "$status"' EXIT TERM INT

log "stopping queue worker so benchmark traffic is isolated"
if command -v screen >/dev/null 2>&1; then screen -S "$SCREEN_NAME" -X quit >/dev/null 2>&1 || true; fi

IFS=',' read -r -a PROFILE_LIST <<<"$PROFILES"
for profile in "${PROFILE_LIST[@]}"; do
  profile="${profile//[[:space:]]/}"
  [[ "$profile" =~ ^[0-9]+$ && "$profile" -ge 1 ]] || fatal "invalid server parallel profile: $profile"
  log "testing llama.cpp --parallel ${profile}"
  stop_model
  command_with_parallel "$profile"
  start_command "parallel-${profile}" "${PROFILE_CMD[@]}"

  nvidia-smi --query-gpu=timestamp,name,memory.total,memory.used,utilization.gpu,utilization.memory --format=csv,nounits \
    -l 1 >"$OUT_DIR/gpu-parallel-${profile}.csv" 2>&1 &
  GPU_SAMPLER_PID=$!

  set +e
  DIV3RSA_INFERENCE_BASE_URL="http://127.0.0.1:${MODEL_PORT}/v1" \
  DIV3RSA_INFERENCE_API_KEY="$API_KEY" \
  DIV3RSA_BENCH_CONCURRENCY="$CLIENT_MATRIX" \
  DIV3RSA_BENCH_OUTPUT="$OUT_DIR/parallel-${profile}.json" \
    node "$REPO_DIR/scripts/benchmark_model_concurrency.mjs" >"$OUT_DIR/parallel-${profile}.stdout.json" 2>"$OUT_DIR/parallel-${profile}.stderr.log"
  bench_status=$?
  set -e

  kill "$GPU_SAMPLER_PID" >/dev/null 2>&1 || true
  wait "$GPU_SAMPLER_PID" 2>/dev/null || true
  [[ "$bench_status" -eq 0 ]] || fatal "benchmark failed for parallel=${profile}; see $OUT_DIR/parallel-${profile}.stderr.log"
done

restore_original
trap - EXIT TERM INT

node --input-type=module - "$OUT_DIR" "${PROFILE_LIST[@]}" <<'NODE'
import { readFile } from "node:fs/promises";
const [dir, ...profiles] = process.argv.slice(2);
const rows = [];
for (const raw of profiles) {
  const profile = raw.trim();
  const data = JSON.parse(await readFile(`${dir}/parallel-${profile}.json`, "utf8"));
  for (const level of data.levels ?? []) {
    rows.push({
      serverParallel: Number(profile),
      clients: level.summary.concurrency,
      ttftP95Ms: level.summary.ttftMs?.p95,
      totalP95Ms: level.summary.totalMs?.p95,
      aggregateTokS: level.summary.aggregateOutputTokensPerSecond,
      meanModelTokS: level.summary.meanModelTokensPerSecond,
      errors: level.summary.errors
    });
  }
}
console.log(JSON.stringify({ benchmarkDirectory: dir, rows }, null, 2));
NODE

log "benchmark complete; raw evidence: $OUT_DIR"
log "original production profile is restored; no benchmark profile was promoted automatically"