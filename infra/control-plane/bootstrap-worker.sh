#!/usr/bin/env bash
set -Eeuo pipefail

fatal(){ printf '[control-plane-bootstrap] %s\n' "$*" >&2; exit 1; }
log(){ printf '[control-plane-bootstrap] %s\n' "$*"; }

[[ "${EUID}" -eq 0 ]] || fatal "run as root"
: "${DIV3RSA_RUNTIME_GIT_REF:?DIV3RSA_RUNTIME_GIT_REF must be an exact 40-character commit SHA}"
[[ "$DIV3RSA_RUNTIME_GIT_REF" =~ ^[0-9a-fA-F]{40}$ ]] || fatal "DIV3RSA_RUNTIME_GIT_REF must be an exact 40-character commit SHA"

ROOT=${DIV3RSA_CONTROL_PLANE_ROOT:-/opt/div3rsa/localai}
APP="$ROOT/app"
SECRETS="$ROOT/secrets"
LOGS="$ROOT/logs"
STATE="$ROOT/state"
REPO_URL=${DIV3RSA_REPOSITORY_URL:-https://github.com/heke99/localai.git}
ENV_FILE="$SECRETS/control-plane.env"

command -v git >/dev/null || fatal "git is required"
command -v node >/dev/null || fatal "Node.js 24+ is required"
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$node_major" -ge 24 ]] || fatal "Node.js 24+ required"
command -v npm >/dev/null || fatal "npm is required"

id div3rsa >/dev/null 2>&1 || useradd --system --home "$ROOT" --shell /usr/sbin/nologin div3rsa
install -d -m 0750 -o div3rsa -g div3rsa "$ROOT" "$SECRETS" "$LOGS" "$STATE"
[[ -f "$ENV_FILE" ]] || fatal "provision secrets first: $ENV_FILE"
chmod 600 "$ENV_FILE"
chown div3rsa:div3rsa "$ENV_FILE"

if [[ ! -d "$APP/.git" ]]; then
  git clone --no-checkout "$REPO_URL" "$APP"
fi
git -C "$APP" fetch --prune origin main
git -C "$APP" cat-file -e "${DIV3RSA_RUNTIME_GIT_REF}^{commit}" || fatal "requested commit unavailable"
git -C "$APP" merge-base --is-ancestor "$DIV3RSA_RUNTIME_GIT_REF" origin/main || fatal "requested commit is not contained in origin/main"
git -C "$APP" reset --hard "$DIV3RSA_RUNTIME_GIT_REF"
git -C "$APP" clean -fd
[[ "$(git -C "$APP" rev-parse HEAD)" == "$DIV3RSA_RUNTIME_GIT_REF" ]] || fatal "checkout mismatch"

cd "$APP"
npm ci --omit=dev --ignore-scripts
node scripts/build_skill_manifest.mjs
node --experimental-transform-types --import ./infra/runpod/native-typescript-register.mjs scripts/smoke_native_ts_runtime.mjs

# Fail closed: a CPU control plane must route through the registry and must never self-register as inference.
grep -Eq '^(export[[:space:]]+)?DIV3RSA_INFERENCE_ROUTING_MODE=(registry|["'"']registry["'"'])$' "$ENV_FILE" || fatal "DIV3RSA_INFERENCE_ROUTING_MODE=registry is required"
if grep -Eq '^(export[[:space:]]+)?DIV3RSA_RUNTIME_ROLE=(inference|combined)' "$ENV_FILE"; then
  fatal "control plane cannot use inference/combined runtime role"
fi

install -m 0644 infra/control-plane/div3rsa-agent-worker.service /etc/systemd/system/div3rsa-agent-worker.service
systemctl daemon-reload
systemctl enable div3rsa-agent-worker.service
systemctl restart div3rsa-agent-worker.service
sleep 4
systemctl is-active --quiet div3rsa-agent-worker.service || {
  journalctl -u div3rsa-agent-worker.service -n 100 --no-pager >&2 || true
  fatal "control-plane worker failed to start"
}

log "ready sha=$DIV3RSA_RUNTIME_GIT_REF routing=registry role=control-plane"
