#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="${DIV3RSA_LEGACY_ROOT_DIR:-/root/autodl-tmp/localai}"
REPO_DIR="${DIV3RSA_LEGACY_APP_DIR:-${ROOT_DIR}/app}"
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
