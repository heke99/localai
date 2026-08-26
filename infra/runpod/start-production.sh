#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export DIV3RSA_RUNTIME_PROVIDER="${DIV3RSA_RUNTIME_PROVIDER:-runpod}"
export DIV3RSA_START_PROVIDER_BASE_SERVICES="${DIV3RSA_START_PROVIDER_BASE_SERVICES:-${DIV3RSA_START_RUNPOD_BASE_SERVICES:-1}}"
exec bash "$SCRIPT_DIR/../runtime/start-production.sh"
