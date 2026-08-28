#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="${DIV3RSA_LEGACY_ROOT_DIR:-/root/autodl-tmp/localai}"
REPO_DIR="${DIV3RSA_LEGACY_APP_DIR:-${ROOT_DIR}/app}"
BASE_SCRIPT="${REPO_DIR}/infra/runtime/upgrade-legacy-gpuhub-base.sh"

# First deployment compatibility: before the promotion revision is checked out,
# the host still contains the previous monolithic upgrader at the canonical path.
if [[ ! -f "$BASE_SCRIPT" ]]; then
  BASE_SCRIPT="${REPO_DIR}/infra/runtime/upgrade-legacy-gpuhub.sh"
fi
[[ -f "$BASE_SCRIPT" ]] || { echo "GPUHub base upgrade script missing: $BASE_SCRIPT" >&2; exit 1; }

bash "$BASE_SCRIPT" "$@"

# The base upgrade may have checked out a new revision. Resolve the reconciler
# after it returns so every successful deploy converges llama.cpp to the tracked
# durable production profile.
RECONCILE_SCRIPT="${REPO_DIR}/infra/runtime/reconcile-gpuhub-production-profile.sh"
[[ -f "$RECONCILE_SCRIPT" ]] || { echo "GPUHub production profile reconciler missing after upgrade: $RECONCILE_SCRIPT" >&2; exit 1; }
exec bash "$RECONCILE_SCRIPT"
