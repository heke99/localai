#!/usr/bin/env bash
set -Eeuo pipefail

root=/root/autodl-tmp/localai
app="$root/app"
server="$root/runtime/llama.cpp/build/bin/llama-server"
model="$root/models/qwen/current/Qwen3.8-27B-OBLITERATED-Q8_0.gguf"
keyfile="$root/secrets/inference-api-key"
node="$root/runtime/node-current/bin/node"
envfile="$root/secrets/gpuhub-worker.env"
logdir="$root/logs/ngram-agent-gate-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$logdir"
cd "$app"
expected=a173e8cd71e40ba8ec4dfd92e3a1b3829050905c
[[ "$(git rev-parse HEAD)" == "$expected" ]] || { echo "wrong production SHA" >&2; exit 1; }

health() { curl --fail --silent --show-error --max-time 3 http://127.0.0.1:6006/health >/dev/null 2>&1; }
stop_worker() { screen -S localai-agent -X quit >/dev/null 2>&1 || true; }
stop_model() {
  mapfile -t pids < <(pgrep -f 'llama-server.*Qwen3\.8-27B-OBLITERATED-Q8_0\.gguf' || true)
  for pid in "${pids[@]}"; do kill -TERM "$pid" 2>/dev/null || true; done
  for _ in {1..80}; do [[ -z "$(pgrep -f 'llama-server.*Qwen3\.8-27B-OBLITERATED-Q8_0\.gguf' || true)" ]] && return 0; sleep 0.25; done
  mapfile -t pids < <(pgrep -f 'llama-server.*Qwen3\.8-27B-OBLITERATED-Q8_0\.gguf' || true)
  for pid in "${pids[@]}"; do kill -KILL "$pid" 2>/dev/null || true; done
  sleep 1
}
start_ngram() {
  stop_model
  nohup "$server" --model "$model" --alias localai-qwen38-v3-q8 --host 0.0.0.0 --port 6006 --api-key-file "$keyfile" -ngl all --ctx-size 262144 --parallel 8 --cont-batching --flash-attn on --batch-size 2048 --ubatch-size 512 --no-webui --spec-type ngram-mod >"$logdir/ngram.server.log" 2>&1 &
  for _ in {1..180}; do health && return 0; sleep 1; done
  tail -n 120 "$logdir/ngram.server.log" >&2
  return 1
}
start_worker() {
  stop_worker
  screen -dmS localai-agent bash -lc "
    set -Eeuo pipefail
    export PATH='$(dirname "$node")':\$PATH
    set -a
    source '$envfile'
    set +a
    export DIV3RSA_MODEL_PARALLEL=8
    export DIV3RSA_MODEL_CONTEXT_SIZE=32768
    cd '$app'
    exec node --experimental-transform-types --import ./infra/runpod/native-typescript-register.mjs services/agent-worker/src/main.ts >>'$root/logs/agent-worker.log' 2>&1
  "
  sleep 3
  screen -list | grep -F '.localai-agent' >/dev/null
}
restore() {
  status=$?
  trap - EXIT INT TERM
  set +e
  stop_worker
  stop_model
  DIV3RSA_FORCE_MODEL_RESTART=1 DIV3RSA_MODEL_PARALLEL=8 DIV3RSA_MODEL_CONTEXT_SIZE=262144 bash "$app/infra/runtime/recover-legacy-gpuhub.sh"
  restore_status=$?
  health
  screen -list | grep -F '.localai-agent' >/dev/null
  pgrep -af 'llama-server.*Qwen3\.8-27B-OBLITERATED-Q8_0\.gguf'
  echo "Evidence: $logdir"
  rm -f /tmp/div3rsa-ngram-agent-gate.sh
  if [[ "$restore_status" -ne 0 ]]; then exit "$restore_status"; fi
  exit "$status"
}
trap restore EXIT INT TERM

# Pause new work, then start the candidate cleanly.
stop_worker
sleep 2
start_ngram
start_worker
process="$(pgrep -af 'llama-server.*Qwen3\.8-27B-OBLITERATED-Q8_0\.gguf')"
[[ "$process" =~ --spec-type[=\ ]+ngram-mod ]] || { echo "ngram candidate not active" >&2; exit 1; }

set -a
# shellcheck disable=SC1090
source "$envfile"
set +a
export DIV3RSA_REPOSITORY_ROOT="$app"
export DIV3RSA_EVAL_COMMIT_SHA="$expected"
export DIV3RSA_EVAL_OUTPUT="$logdir/eval.json"
export DIV3RSA_EVAL_MIN_PASS_RATE=1
export DIV3RSA_MODEL_PARALLEL=8
export DIV3RSA_MODEL_CONTEXT_SIZE=32768

echo "=== NGRAM FULL AGENT EVAL ==="
"$node" --experimental-transform-types --import ./infra/runpod/native-typescript-register.mjs scripts/eval_agent_runtime.ts >"$logdir/eval.stdout.json" 2>"$logdir/eval.stderr.log"
cat "$logdir/eval.stderr.log"
cat "$logdir/eval.stdout.json"
python3 - "$logdir/eval.json" <<'PY'
import json,sys
r=json.load(open(sys.argv[1],encoding='utf-8'))
fail=[]
if r.get('cases') != 8: fail.append(f"cases={r.get('cases')}")
if r.get('passed') != 8: fail.append(f"passed={r.get('passed')}")
if r.get('failed') != 0: fail.append(f"failed={r.get('failed')}")
if r.get('passRate') != 1: fail.append(f"passRate={r.get('passRate')}")
if r.get('allowed') is not True: fail.append(f"allowed={r.get('allowed')}")
if r.get('liveOracleFailures') != []: fail.append(f"liveOracleFailures={r.get('liveOracleFailures')}")
if fail: raise SystemExit('ngram agent eval failed: '+', '.join(fail))
print('[ngram-gate] full agent eval passed 8/8')
PY

# Remove worker noise before raw p8 throughput measurement.
stop_worker
export DIV3RSA_INFERENCE_BASE_URL=http://127.0.0.1:6006/v1
export DIV3RSA_INFERENCE_API_KEY="$(cat "$keyfile")"
export DIV3RSA_MODEL_RUNTIME_ALIAS=localai-qwen38-v3-q8
export DIV3RSA_BENCH_CONCURRENCY=1,4,8
export DIV3RSA_BENCH_REQUESTS_PER_WORKER=1
export DIV3RSA_BENCH_WARMUP_REQUESTS=1
export DIV3RSA_BENCH_MAX_TOKENS=256
export DIV3RSA_BENCH_ACTIVE_SERVER_PARALLEL=8
export DIV3RSA_BENCH_ACTIVE_TOTAL_CONTEXT=262144
export DIV3RSA_BENCH_CONTEXT_PER_SLOT=32768
export DIV3RSA_BENCH_OUTPUT="$logdir/throughput.json"

echo "=== NGRAM P8 THROUGHPUT ==="
"$node" scripts/benchmark_model_concurrency.mjs | tee "$logdir/throughput.stdout.json"

python3 - "$logdir/throughput.json" <<'PY'
import json,sys
r=json.load(open(sys.argv[1],encoding='utf-8'))
for level in r['levels']:
    s=level['summary']
    if s['errors'] != 0: raise SystemExit(f"throughput errors at c={s['concurrency']}: {s['errors']}")
print('[ngram-gate] throughput requests completed with zero errors')
PY
