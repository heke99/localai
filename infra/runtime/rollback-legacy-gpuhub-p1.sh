#!/usr/bin/env bash
set -Eeuo pipefail

log() { printf '[gpuhub-p1-rollback] %s\n' "$*"; }
fatal() { log "$*" >&2; exit 1; }
[[ "${EUID}" -eq 0 ]] || fatal "run as root on the GPUHub host"
[[ "${DIV3RSA_P1_ROLLBACK_CONFIRM:-}" == "YES" ]] || fatal "set DIV3RSA_P1_ROLLBACK_CONFIRM=YES"

ROOT_DIR="${DIV3RSA_LEGACY_ROOT_DIR:-/root/autodl-tmp/localai}"
REPO_DIR="${DIV3RSA_LEGACY_APP_DIR:-${ROOT_DIR}/app}"
ENV_FILE="${DIV3RSA_LEGACY_ENV_FILE:-${ROOT_DIR}/secrets/gpuhub-worker.env}"
OVERRIDE_FILE="${DIV3RSA_GPUHUB_RUNTIME_PROFILE_OVERRIDE_FILE:-${ROOT_DIR}/secrets/gpuhub-model-profile-override.env}"
RECOVERY_SCRIPT="${REPO_DIR}/infra/runtime/recover-legacy-gpuhub.sh"
SEARCH_CHECK="${REPO_DIR}/infra/runtime/check-search-capability.sh"
MODEL_PORT="${DIV3RSA_MODEL_PORT:-6006}"
SCREEN_NAME="${DIV3RSA_LEGACY_WORKER_SCREEN:-localai-agent}"

[[ -f "$ENV_FILE" && -f "$RECOVERY_SCRIPT" && -f "$SEARCH_CHECK" ]] || fatal "rollback prerequisites missing"
mkdir -p "$(dirname "$OVERRIDE_FILE")"
cat >"$OVERRIDE_FILE" <<'OVERRIDE'
DIV3RSA_GPUHUB_OVERRIDE_PARALLEL=1
DIV3RSA_GPUHUB_OVERRIDE_TOTAL_CONTEXT=32768
OVERRIDE
chmod 600 "$OVERRIDE_FILE"

python3 - "$ENV_FILE" <<'PY'
from pathlib import Path
import re, sys
p=Path(sys.argv[1]); t=p.read_text(encoding="utf-8")
for k,v in (("DIV3RSA_MODEL_PARALLEL","1"),("DIV3RSA_MODEL_CONTEXT_SIZE","32768")):
    line=f"export {k}={v}"; pat=re.compile(rf"^(?:export\s+)?{re.escape(k)}=.*$", re.M)
    t=pat.sub(line,t) if pat.search(t) else t+("" if not t or t.endswith("\n") else "\n")+line+"\n"
p.write_text(t,encoding="utf-8")
PY
chmod 600 "$ENV_FILE"

DIV3RSA_FORCE_MODEL_RESTART=1 bash "$RECOVERY_SCRIPT"
cmd="$(pgrep -af 'llama-server.*Qwen3\.8-27B-OBLITERATED-Q8_0\.gguf')"
[[ "$cmd" =~ --parallel[=\ ]+1 ]] || fatal "rollback did not restore parallel=1: $cmd"
[[ "$cmd" =~ --ctx-size[=\ ]+32768 ]] || fatal "rollback did not restore ctx=32768: $cmd"
curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:${MODEL_PORT}/health" >/dev/null
bash "$SEARCH_CHECK" http://127.0.0.1:8890 >/dev/null
screen -list | grep -F ".${SCREEN_NAME}" >/dev/null
log "emergency p1/32768 rollback active; durable tracked target remains unchanged"
