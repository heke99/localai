#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="${DIV3RSA_LEGACY_ROOT_DIR:-/root/autodl-tmp/localai}"
REPO_DIR="${DIV3RSA_LEGACY_APP_DIR:-${ROOT_DIR}/app}"
ENV_FILE="${DIV3RSA_LEGACY_ENV_FILE:-${ROOT_DIR}/secrets/gpuhub-worker.env}"
WORKER_SCREEN="${DIV3RSA_LEGACY_WORKER_SCREEN:-localai-agent}"
BASE_SCRIPT="${REPO_DIR}/infra/runtime/upgrade-legacy-gpuhub-base.sh"

# First deployment compatibility: before the promotion revision is checked out,
# the host still contains the previous monolithic/base upgrader at the canonical path.
if [[ ! -f "$BASE_SCRIPT" ]]; then
  BASE_SCRIPT="${REPO_DIR}/infra/runtime/upgrade-legacy-gpuhub.sh"
fi
[[ -f "$BASE_SCRIPT" ]] || { echo "GPUHub base upgrade script missing: $BASE_SCRIPT" >&2; exit 1; }

bash "$BASE_SCRIPT" "$@"

# The base upgrade can replace the repository checkout while this wrapper keeps
# running from /tmp. Resolve post-checkout hooks only after the base returns so
# first-deploy cutovers cannot accidentally execute the previous revision's hook set.
SECURITY_SKILL_SYNC="${REPO_DIR}/infra/runtime/sync-security-skills.sh"
[[ -f "$SECURITY_SKILL_SYNC" ]] || { echo "GPUHub security skill sync missing after upgrade: $SECURITY_SKILL_SYNC" >&2; exit 1; }
DIV3RSA_LEGACY_ROOT_DIR="$ROOT_DIR" DIV3RSA_LEGACY_APP_DIR="$REPO_DIR" bash "$SECURITY_SKILL_SYNC"

# Resolve the reconciler after checkout for the same reason: every successful
# deploy must converge llama.cpp to the tracked durable production profile.
RECONCILE_SCRIPT="${REPO_DIR}/infra/runtime/reconcile-gpuhub-production-profile.sh"
[[ -f "$RECONCILE_SCRIPT" ]] || { echo "GPUHub production profile reconciler missing after upgrade: $RECONCILE_SCRIPT" >&2; exit 1; }
bash "$RECONCILE_SCRIPT"

# Function calling is a production contract, not an optional model behavior.
# Probe the OpenAI-compatible structured tool-call response. If an older healthy
# server was started without Jinja parsing, the probe performs one controlled
# recovery with LLAMA_ARG_JINJA=1 and refuses the deployment if parsing still fails.
TOOL_CALL_SCRIPT="${REPO_DIR}/infra/runtime/ensure-tool-calling-runtime.sh"
[[ -f "$TOOL_CALL_SCRIPT" ]] || { echo "GPUHub tool-calling probe missing after upgrade: $TOOL_CALL_SCRIPT" >&2; exit 1; }
DIV3RSA_LEGACY_ROOT_DIR="$ROOT_DIR" DIV3RSA_LEGACY_APP_DIR="$REPO_DIR" bash "$TOOL_CALL_SCRIPT"

# RAG uses a separate, loopback-only embedding llama-server. Keep it independent
# from the generation server so embedding traffic cannot consume generation slots
# or require a model/runtime restart when knowledge is ingested.
EMBEDDING_SCRIPT="${REPO_DIR}/infra/runtime/ensure-embedding-runtime.sh"
[[ -f "$EMBEDDING_SCRIPT" ]] || { echo "GPUHub embedding runtime provisioner missing after upgrade: $EMBEDDING_SCRIPT" >&2; exit 1; }
DIV3RSA_LEGACY_ROOT_DIR="$ROOT_DIR" DIV3RSA_LEGACY_APP_DIR="$REPO_DIR" bash "$EMBEDDING_SCRIPT"

ensure_env_value() {
  local key="$1" value="$2"
  python3 - "$ENV_FILE" "$key" "$value" <<'PY'
from pathlib import Path
import re, shlex, sys
path = Path(sys.argv[1])
key, value = sys.argv[2], sys.argv[3]
text = path.read_text(encoding="utf-8")
pattern = re.compile(rf"^(?:export\s+)?{re.escape(key)}=.*$", re.M)
line = f"export {key}={shlex.quote(value)}"
if pattern.search(text):
    text = pattern.sub(line, text)
else:
    if text and not text.endswith("\n"):
        text += "\n"
    text += line + "\n"
path.write_text(text, encoding="utf-8")
PY
  chmod 600 "$ENV_FILE"
}

# GPUHub intentionally keeps the model/search/security runtimes native. Add the
# new public-web egress boundary the same way so the agent gets outbound HTTP(S)
# without host networking or a Docker dependency.
EGRESS_SCRIPT="${REPO_DIR}/infra/runtime/provision-egress-proxy-gpuhub.sh"
[[ -f "$EGRESS_SCRIPT" ]] || { echo "GPUHub egress provisioner missing after upgrade: $EGRESS_SCRIPT" >&2; exit 1; }
DIV3RSA_LEGACY_ROOT_DIR="$ROOT_DIR" DIV3RSA_LEGACY_APP_DIR="$REPO_DIR" bash "$EGRESS_SCRIPT"
EGRESS_URL="http://127.0.0.1:7318"

# The browser executor is isolated from the worker under its own system account.
# It accepts only run-scoped browser operations and routes every public request
# through the DNS-pinned egress proxy above.
BROWSER_SCRIPT="${REPO_DIR}/infra/runtime/provision-browser-executor-gpuhub.sh"
[[ -f "$BROWSER_SCRIPT" ]] || { echo "GPUHub browser provisioner missing after upgrade: $BROWSER_SCRIPT" >&2; exit 1; }
DIV3RSA_LEGACY_ROOT_DIR="$ROOT_DIR" \
DIV3RSA_LEGACY_APP_DIR="$REPO_DIR" \
DIV3RSA_EGRESS_PROXY_URL="$EGRESS_URL" \
  bash "$BROWSER_SCRIPT"
BROWSER_URL="http://127.0.0.1:7320"
BROWSER_TOKEN_FILE="${DIV3RSA_BROWSER_EXECUTOR_TOKEN_FILE:-/var/lib/div3rsa-browser/executor.token}"
[[ -s "$BROWSER_TOKEN_FILE" ]] || { echo "GPUHub browser token missing: $BROWSER_TOKEN_FILE" >&2; exit 1; }
BROWSER_TOKEN="$(tr -d '\r\n' <"$BROWSER_TOKEN_FILE")"
[[ "$BROWSER_TOKEN" =~ ^[0-9a-f]{64}$ ]] || { echo "GPUHub browser token invalid" >&2; exit 1; }

ensure_env_value NODE_USE_ENV_PROXY "1"
ensure_env_value HTTP_PROXY "$EGRESS_URL"
ensure_env_value HTTPS_PROXY "$EGRESS_URL"
ensure_env_value NO_PROXY "localhost,127.0.0.1,::1"
ensure_env_value DIV3RSA_EGRESS_PROXY_URL "$EGRESS_URL"
ensure_env_value DIV3RSA_BROWSER_EXECUTOR_URL "$BROWSER_URL"
ensure_env_value DIV3RSA_BROWSER_EXECUTOR_TOKEN "$BROWSER_TOKEN"
ensure_env_value DIV3RSA_BROWSER_TIMEOUT_MS "30000"
unset BROWSER_TOKEN

# Reload only the agent worker so the model stays hot. The recovery path detects
# the healthy Qwen server and recreates the missing worker with the new env.
screen -S "$WORKER_SCREEN" -X quit >/dev/null 2>&1 || true
RECOVERY_SCRIPT="${REPO_DIR}/infra/runtime/recover-legacy-gpuhub.sh"
[[ -f "$RECOVERY_SCRIPT" ]] || { echo "GPUHub recovery script missing after upgrade: $RECOVERY_SCRIPT" >&2; exit 1; }
DIV3RSA_LEGACY_ROOT_DIR="$ROOT_DIR" DIV3RSA_LEGACY_APP_DIR="$REPO_DIR" bash "$RECOVERY_SCRIPT"

curl --fail --silent --show-error --max-time 3 "${EGRESS_URL}/_div3rsa_health" >/dev/null
curl --fail --silent --show-error --max-time 3 "${BROWSER_URL}/health" >/dev/null
screen -list | grep -F ".${WORKER_SCREEN}" >/dev/null || { echo "GPUHub worker unavailable after network sidecar cutover" >&2; exit 1; }
printf '[gpuhub-upgrade] network sidecars ready egress=%s browser=%s worker=%s\n' "$EGRESS_URL" "$BROWSER_URL" "$WORKER_SCREEN"
