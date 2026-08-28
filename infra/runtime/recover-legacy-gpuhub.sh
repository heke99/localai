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

exec bash "$V2_SCRIPT" "$@"
