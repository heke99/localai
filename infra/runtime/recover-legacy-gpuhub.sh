#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="${DIV3RSA_LEGACY_ROOT_DIR:-/root/autodl-tmp/localai}"
REPO_DIR="${DIV3RSA_LEGACY_APP_DIR:-${ROOT_DIR}/app}"
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
# the old checkout: doing so can run an obsolete embedding or security provisioner
# before the exact revision has replaced it.
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
  printf '[gpuhub-recovery] pre-checkout wrapper detected; deferring embedding/security recovery until exact target checkout\n'
  exit 0
fi

ensure_security_executor() {
  local worker_env="${DIV3RSA_LEGACY_ENV_FILE:-${ROOT_DIR}/secrets/gpuhub-worker.env}"
  local install_root="${DIV3RSA_SECURITY_INSTALL_ROOT:-/opt/div3rsa/localai}"
  local executor_env="${DIV3RSA_SECURITY_ENV_FILE:-/etc/div3rsa/security-executor.env}"
  local supervisor="${install_root}/infra/runtime/security-executor-supervisor.sh"
  local executor_url enabled deadline

  [[ -r "$worker_env" ]] || return 0
  enabled="$(sed -n 's/^DIV3RSA_SECURITY_TOOL_RUNTIME_ENABLED=//p' "$worker_env" | tail -n 1 | tr '[:upper:]' '[:lower:]')"
  case "$enabled" in
    1|true|yes|on) ;;
    *) return 0 ;;
  esac

  executor_url="$(sed -n 's/^DIV3RSA_SECURITY_EXECUTOR_URL=//p' "$worker_env" | tail -n 1)"
  executor_url="${executor_url:-http://127.0.0.1:7319}"
  executor_url="${executor_url%/}"

  if curl --fail --silent --show-error --max-time 3 "${executor_url}/health" >/dev/null 2>&1; then
    printf '[gpuhub-recovery] security executor already healthy at %s\n' "$executor_url"
    return 0
  fi

  [[ -x "$supervisor" ]] || { echo "security executor enabled but supervisor missing: $supervisor" >&2; return 1; }
  [[ -r "$executor_env" ]] || { echo "security executor enabled but env missing: $executor_env" >&2; return 1; }

  printf '[gpuhub-recovery] security executor unhealthy; restarting bounded executor\n'
  DIV3RSA_SECURITY_INSTALL_ROOT="$install_root" \
  DIV3RSA_SECURITY_ENV_FILE="$executor_env" \
    bash "$supervisor" restart

  deadline=$((SECONDS + ${DIV3RSA_SECURITY_BOOT_TIMEOUT_SECONDS:-45}))
  until curl --fail --silent --show-error --max-time 2 "${executor_url}/health" >/dev/null 2>&1; do
    if (( SECONDS >= deadline )); then
      DIV3RSA_SECURITY_INSTALL_ROOT="$install_root" \
      DIV3RSA_SECURITY_ENV_FILE="$executor_env" \
        bash "$supervisor" logs || true
      echo "security executor failed recovery health check" >&2
      return 1
    fi
    sleep 1
  done

  DIV3RSA_SECURITY_INSTALL_ROOT="$install_root" \
  DIV3RSA_SECURITY_ENV_FILE="$executor_env" \
    bash "$supervisor" status
  printf '[gpuhub-recovery] security executor recovered at %s\n' "$executor_url"
}

# The agent worker may be alive while its dedicated security executor has died.
# Recover that dependency independently, but only on the canonical post-checkout
# path so the supervisor and executor snapshot always match the checked-out code.
ensure_security_executor

# Only the canonical post-checkout wrapper may restore the independent embedding
# runtime. At this point REPO_DIR is guaranteed to contain the same revision as
# the wrapper, so the provisioner and its lifecycle contract cannot be stale.
EMBEDDING_SCRIPT="${REPO_DIR}/infra/runtime/ensure-embedding-runtime.sh"
if [[ -f "$EMBEDDING_SCRIPT" ]]; then
  DIV3RSA_LEGACY_ROOT_DIR="$ROOT_DIR" DIV3RSA_LEGACY_APP_DIR="$REPO_DIR" bash "$EMBEDDING_SCRIPT"
fi
