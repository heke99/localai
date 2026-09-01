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
# the old checkout: doing so can run an obsolete embedding provisioner before the
# exact revision has replaced it.
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
  printf '[gpuhub-recovery] pre-checkout wrapper detected; deferring embedding recovery until exact target checkout\n'
  exit 0
fi

# Only the canonical post-checkout wrapper may restore the independent embedding
# runtime. At this point REPO_DIR is guaranteed to contain the same revision as
# the wrapper, so the provisioner and its lifecycle contract cannot be stale.
EMBEDDING_SCRIPT="${REPO_DIR}/infra/runtime/ensure-embedding-runtime.sh"
if [[ -f "$EMBEDDING_SCRIPT" ]]; then
  DIV3RSA_LEGACY_ROOT_DIR="$ROOT_DIR" DIV3RSA_LEGACY_APP_DIR="$REPO_DIR" bash "$EMBEDDING_SCRIPT"
fi
