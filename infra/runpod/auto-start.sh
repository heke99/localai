#!/usr/bin/env bash
set -Eeuo pipefail

REPO_DIR="${DIV3RSA_REPO_DIR:-/workspace/localai-app}"

if [[ ! -d "$REPO_DIR/.git" ]]; then
  printf '[runpod-auto-start] repository not found at %s\n' "$REPO_DIR" >&2
  exit 66
fi

cd "$REPO_DIR"
exec env DIV3RSA_START_RUNPOD_BASE_SERVICES="${DIV3RSA_START_RUNPOD_BASE_SERVICES:-1}" \
  bash infra/runpod/start-production.sh
