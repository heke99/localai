#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="${DIV3RSA_LEGACY_ROOT_DIR:-/root/autodl-tmp/localai}"
REPO_DIR="${DIV3RSA_LEGACY_APP_DIR:-${ROOT_DIR}/app}"
V2_SCRIPT="${REPO_DIR}/infra/runtime/recover-legacy-gpuhub-v2.sh"

# During the first deploy of the v2 recovery contract GitHub executes this
# target-revision wrapper before the target revision has been checked out on the
# host. In that one case, preserve the currently deployed recovery implementation.
if [[ ! -f "$V2_SCRIPT" ]]; then
  LEGACY_SCRIPT="${REPO_DIR}/infra/runtime/recover-legacy-gpuhub-p1.sh"
  if [[ -f "$LEGACY_SCRIPT" ]]; then
    exec bash "$LEGACY_SCRIPT" "$@"
  fi
  # Pre-checkout compatibility with the previously deployed revision, where the
  # canonical recovery path is still the proven p1 implementation.
  LEGACY_SCRIPT="${REPO_DIR}/infra/runtime/recover-legacy-gpuhub.sh"
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

# On a post-checkout recovery, restore the independent embedding runtime too.
# First-deploy pre-checkout recovery intentionally exits through the legacy path
# above because the embedding provisioner does not exist on the old revision yet.
EMBEDDING_SCRIPT="${REPO_DIR}/infra/runtime/ensure-embedding-runtime.sh"
if [[ -f "$EMBEDDING_SCRIPT" ]]; then
  DIV3RSA_LEGACY_ROOT_DIR="$ROOT_DIR" DIV3RSA_LEGACY_APP_DIR="$REPO_DIR" bash "$EMBEDDING_SCRIPT"
fi
