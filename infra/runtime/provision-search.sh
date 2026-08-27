#!/usr/bin/env bash
set -Eeuo pipefail

REPO_DIR="${DIV3RSA_REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
SEARCH_PORT="${DIV3RSA_SEARCH_PORT:-8888}"
COMPOSE_FILE="$REPO_DIR/infra/docker/search.compose.yaml"
STATE_DIR="${DIV3RSA_RUNTIME_STATE_DIR:-/etc/div3rsa}"
SECRET_FILE="${DIV3RSA_SEARCH_SECRET_FILE:-$STATE_DIR/searxng.secret}"

log() { printf '[search-provision] %s\n' "$*"; }

if ! command -v docker >/dev/null 2>&1; then
  log "docker is required to provision SearXNG"
  exit 69
fi

compose=()
if docker compose version >/dev/null 2>&1; then
  compose=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  compose=(docker-compose)
else
  log "docker compose v2 or docker-compose is required"
  exit 69
fi

if [[ ! -f "$COMPOSE_FILE" ]]; then
  log "compose file missing: $COMPOSE_FILE"
  exit 66
fi

mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"
if [[ -z "${SEARXNG_SECRET:-}" ]]; then
  if [[ -s "$SECRET_FILE" ]]; then
    SEARXNG_SECRET="$(cat "$SECRET_FILE")"
  else
    umask 077
    SEARXNG_SECRET="$(python3 - <<'PY'
import secrets
print(secrets.token_hex(32))
PY
)"
    printf '%s\n' "$SEARXNG_SECRET" >"$SECRET_FILE"
    chmod 600 "$SECRET_FILE"
  fi
fi
export SEARXNG_SECRET

log "starting pinned private SearXNG on 127.0.0.1:${SEARCH_PORT}"
(
  cd "$REPO_DIR/infra/docker"
  DIV3RSA_SEARCH_PORT="$SEARCH_PORT" "${compose[@]}" -f search.compose.yaml up -d --pull missing
)

health_url="http://127.0.0.1:${SEARCH_PORT}/search?q=div3rsa-health&format=json"
deadline=$((SECONDS + ${DIV3RSA_SEARCH_BOOT_TIMEOUT_SECONDS:-120}))
while true; do
  if curl --fail --silent --show-error --max-time 5 "$health_url" >/dev/null 2>&1; then
    break
  fi
  if (( SECONDS >= deadline )); then
    log "SearXNG did not become healthy"
    "${compose[@]}" -f "$COMPOSE_FILE" logs --tail=100 searxng || true
    exit 70
  fi
  sleep 2
done

log "SearXNG healthy"
printf 'DIV3RSA_SEARCH_BASE_URL=http://127.0.0.1:%s\n' "$SEARCH_PORT"
