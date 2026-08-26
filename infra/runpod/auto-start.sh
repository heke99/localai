#!/usr/bin/env bash
set -Eeuo pipefail

log() {
  printf '[runpod-auto-start] %s\n' "$*"
}

REPO_DIR="${DIV3RSA_REPO_DIR:-/workspace/localai-app}"
GIT_SYNC_ON_BOOT="${DIV3RSA_GIT_SYNC_ON_BOOT:-1}"
GIT_SYNC_STRICT="${DIV3RSA_GIT_SYNC_STRICT:-0}"
GIT_REMOTE="${DIV3RSA_GIT_REMOTE:-origin}"
GIT_BRANCH="${DIV3RSA_GIT_BRANCH:-main}"

if [[ ! -d "$REPO_DIR/.git" ]]; then
  log "repository not found at ${REPO_DIR}"
  exit 66
fi

cd "$REPO_DIR"

sync_checkout() {
  if [[ "$GIT_SYNC_ON_BOOT" != "1" ]]; then
    log "Git sync disabled; starting existing checkout at $(git rev-parse --short HEAD 2>/dev/null || printf unknown)"
    return 0
  fi

  if ! command -v git >/dev/null 2>&1; then
    log "git is unavailable; cannot sync production checkout"
    [[ "$GIT_SYNC_STRICT" == "1" ]] && return 69
    return 0
  fi

  local old_head old_lock new_lock target_head
  old_head="$(git rev-parse HEAD 2>/dev/null || true)"
  old_lock="$(git rev-parse HEAD:package-lock.json 2>/dev/null || true)"

  log "syncing ${GIT_REMOTE}/${GIT_BRANCH} before runtime start"
  if ! GIT_TERMINAL_PROMPT=0 git fetch --prune --no-tags "$GIT_REMOTE" "$GIT_BRANCH"; then
    log "Git fetch failed; verify the persistent checkout has non-interactive GitHub credentials"
    [[ "$GIT_SYNC_STRICT" == "1" ]] && return 69
    log "continuing with existing checkout because DIV3RSA_GIT_SYNC_STRICT=${GIT_SYNC_STRICT}"
    return 0
  fi

  target_head="$(git rev-parse FETCH_HEAD)"
  if [[ ! "$target_head" =~ ^[0-9a-f]{40}$ ]]; then
    log "refusing sync because fetched target is not a full commit SHA"
    return 69
  fi

  git reset --hard "$target_head"
  new_lock="$(git rev-parse HEAD:package-lock.json 2>/dev/null || true)"
  log "checkout synced ${old_head:-unknown} -> ${target_head}"

  if [[ "$old_lock" != "$new_lock" ]]; then
    if ! command -v npm >/dev/null 2>&1; then
      log "package-lock.json changed but npm is unavailable"
      return 69
    fi
    log "package-lock.json changed; installing pinned production dependencies"
    npm ci --omit=dev --ignore-scripts
  fi
}

sync_checkout

exec env DIV3RSA_START_RUNPOD_BASE_SERVICES="${DIV3RSA_START_RUNPOD_BASE_SERVICES:-1}" \
  bash infra/runpod/start-production.sh
