#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="${DIV3RSA_LEGACY_ROOT_DIR:-/root/autodl-tmp/localai}"
REPO_DIR="${DIV3RSA_LEGACY_APP_DIR:-${ROOT_DIR}/app}"
ENV_FILE="${DIV3RSA_LEGACY_ENV_FILE:-${ROOT_DIR}/secrets/gpuhub-worker.env}"
WORKER_SCREEN="${DIV3RSA_LEGACY_WORKER_SCREEN:-localai-agent}"
V2_SCRIPT="${REPO_DIR}/infra/runtime/recover-legacy-gpuhub-v2.sh"
CANONICAL_WRAPPER="${REPO_DIR}/infra/runtime/recover-legacy-gpuhub.sh"
SCRIPT_PATH="$(readlink -f "${BASH_SOURCE[0]}")"
CANONICAL_PATH="$(readlink -f "$CANONICAL_WRAPPER" 2>/dev/null || true)"
PRECHECKOUT_WRAPPER=0
if [[ -z "$CANONICAL_PATH" || "$SCRIPT_PATH" != "$CANONICAL_PATH" ]]; then
  PRECHECKOUT_WRAPPER=1
fi

# GitHub deploys the target-revision wrapper from /tmp before the target revision
# is checked out on the host. During that phase, only recover the already deployed
# generation/worker runtime. Never invoke target-dependent post-checkout hooks from
# the old checkout: doing so can run an obsolete provisioner before the exact
# revision has replaced it.
if [[ ! -f "$V2_SCRIPT" ]]; then
  LEGACY_SCRIPT="${REPO_DIR}/infra/runtime/recover-legacy-gpuhub-p1.sh"
  if [[ -f "$LEGACY_SCRIPT" ]]; then
    exec bash "$LEGACY_SCRIPT" "$@"
  fi
  LEGACY_SCRIPT="$CANONICAL_WRAPPER"
  [[ -f "$LEGACY_SCRIPT" ]] || { echo "GPUHub legacy recovery script missing: $LEGACY_SCRIPT" >&2; exit 1; }
  exec bash "$LEGACY_SCRIPT" "$@"
fi

# llama.cpp exposes --jinja through LLAMA_ARG_JINJA, but boolean environment
# arguments require a real true/false value on the pinned runtime. The v2
# recovery also emits an explicit --jinja flag so this remains observable in the
# active process profile and cannot silently regress after a restart.
export LLAMA_ARG_JINJA="${LLAMA_ARG_JINJA:-true}"
export DIV3RSA_MODEL_JINJA="${DIV3RSA_MODEL_JINJA:-true}"
bash "$V2_SCRIPT" "$@"

if [[ "$PRECHECKOUT_WRAPPER" -eq 1 ]]; then
  # Keep the established log contract: embeddings remain the first post-checkout
  # hook, while egress/browser recovery is also deferred by this same exit.
  printf '[gpuhub-recovery] pre-checkout wrapper detected; deferring embedding recovery until exact target checkout\n'
  exit 0
fi

remove_browser_worker_env() {
  [[ -f "$ENV_FILE" ]] || return 0
  python3 - "$ENV_FILE" <<'PY'
from pathlib import Path
import re, sys
path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
for key in (
    "DIV3RSA_BROWSER_EXECUTOR_URL",
    "DIV3RSA_BROWSER_EXECUTOR_TOKEN",
    "DIV3RSA_BROWSER_TIMEOUT_MS",
):
    text = re.sub(rf"^(?:export\s+)?{re.escape(key)}=.*(?:\n|$)", "", text, flags=re.M)
path.write_text(text, encoding="utf-8")
PY
  chmod 600 "$ENV_FILE"
}

browser_env_present() {
  [[ -f "$ENV_FILE" ]] && grep -Eq '^(?:export[[:space:]]+)?DIV3RSA_BROWSER_EXECUTOR_(URL|TOKEN)=' "$ENV_FILE"
}

# Only the canonical post-checkout wrapper may restore independent runtimes. At
# this point REPO_DIR is guaranteed to contain the same revision as this wrapper.
EMBEDDING_SCRIPT="${REPO_DIR}/infra/runtime/ensure-embedding-runtime.sh"
if [[ -f "$EMBEDDING_SCRIPT" ]]; then
  DIV3RSA_LEGACY_ROOT_DIR="$ROOT_DIR" DIV3RSA_LEGACY_APP_DIR="$REPO_DIR" bash "$EMBEDDING_SCRIPT"
fi

EGRESS_SCRIPT="${REPO_DIR}/infra/runtime/provision-egress-proxy-gpuhub.sh"
BROWSER_SCRIPT="${REPO_DIR}/infra/runtime/provision-browser-executor-gpuhub.sh"
if [[ -f "$EGRESS_SCRIPT" ]]; then
  DIV3RSA_LEGACY_ROOT_DIR="$ROOT_DIR" DIV3RSA_LEGACY_APP_DIR="$REPO_DIR" bash "$EGRESS_SCRIPT"
fi
if [[ -f "$BROWSER_SCRIPT" ]]; then
  had_browser_env=0
  browser_env_present && had_browser_env=1
  browser_rc=0
  if DIV3RSA_LEGACY_ROOT_DIR="$ROOT_DIR" \
    DIV3RSA_LEGACY_APP_DIR="$REPO_DIR" \
    DIV3RSA_EGRESS_PROXY_URL="${DIV3RSA_EGRESS_PROXY_URL:-http://127.0.0.1:7318}" \
    bash "$BROWSER_SCRIPT"; then
    :
  else
    browser_rc=$?
    if [[ "$browser_rc" -ne 78 ]]; then
      printf '[gpuhub-recovery] browser provisioner failed unexpectedly: rc=%s\n' "$browser_rc" >&2
      exit "$browser_rc"
    fi

    # Code 78 is reserved for a host that cannot prove a safe browser isolation
    # boundary. Remove any previously persisted browser endpoint/token before a
    # worker can advertise those tools. If this recovery inherited stale browser
    # configuration, restart only the worker once against the cleaned env.
    remove_browser_worker_env
    printf '[gpuhub-recovery] browser capability disabled: unavailable_host_isolation\n'
    if [[ "$had_browser_env" -eq 1 ]]; then
      screen -S "$WORKER_SCREEN" -X quit >/dev/null 2>&1 || true
      bash "$V2_SCRIPT" "$@"
    fi
  fi
fi
