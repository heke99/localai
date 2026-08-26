#!/usr/bin/env bash
set -Eeuo pipefail

log() { printf '[runtime-bootstrap] %s\n' "$*"; }
fatal() { log "$*"; exit 1; }

if [[ "${EUID}" -ne 0 ]]; then
  if command -v sudo >/dev/null 2>&1; then
    exec sudo -E bash "$0" "$@"
  fi
  fatal "root privileges are required"
fi

STATE_DIR="${DIV3RSA_RUNTIME_STATE_DIR:-/etc/div3rsa}"
ROOT_DIR="${DIV3RSA_RUNTIME_ROOT_DIR:-/opt/div3rsa}"
REPO_DIR="${DIV3RSA_REPO_DIR:-${ROOT_DIR}/localai}"
LLAMA_DIR="${DIV3RSA_LLAMA_CPP_DIR:-${ROOT_DIR}/llama.cpp}"
MODEL_DIR="${DIV3RSA_MODEL_DIR:-${ROOT_DIR}/models/qwen3.8-27b-obliterated-v3}"
MODEL_FILENAME="Qwen3.8-27B-OBLITERATED-Q8_0.gguf"
MODEL_PORT="${DIV3RSA_MODEL_PORT:-8080}"
NODE_VERSION="${DIV3RSA_NODE_VERSION:-24.19.0}"
PUBLIC_HOST_SUFFIX="${DIV3RSA_RUNTIME_PUBLIC_HOST_SUFFIX:-sslip.io}"
ENV_FILE="${STATE_DIR}/runtime.env"
SERVICE_FILE="/etc/systemd/system/div3rsa-runtime.service"

mkdir -p "$STATE_DIR" "$ROOT_DIR" "$MODEL_DIR"
chmod 700 "$STATE_DIR"

install_packages() {
  if ! command -v apt-get >/dev/null 2>&1; then
    fatal "automatic host bootstrap currently requires an apt-based Linux image; use the static OpenAI-compatible adapter for other images"
  fi
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y --no-install-recommends ca-certificates curl git build-essential cmake ninja-build python3 xz-utils caddy
}

install_node() {
  if command -v node >/dev/null 2>&1; then
    local major
    major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
    if [[ "$major" =~ ^[0-9]+$ ]] && (( major >= 24 )); then
      log "Node $(node --version) already satisfies runtime requirement"
      return
    fi
  fi

  local machine arch archive base checksum_line
  machine="$(uname -m)"
  case "$machine" in
    x86_64|amd64) arch="x64" ;;
    aarch64|arm64) arch="arm64" ;;
    *) fatal "unsupported CPU architecture for pinned Node runtime: ${machine}" ;;
  esac
  archive="node-v${NODE_VERSION}-linux-${arch}.tar.xz"
  base="https://nodejs.org/dist/v${NODE_VERSION}"
  log "installing pinned Node v${NODE_VERSION}"
  curl --fail --location --silent --show-error "${base}/${archive}" -o "/tmp/${archive}"
  curl --fail --location --silent --show-error "${base}/SHASUMS256.txt" -o /tmp/node-SHASUMS256.txt
  checksum_line="$(grep "  ${archive}$" /tmp/node-SHASUMS256.txt || true)"
  [[ -n "$checksum_line" ]] || fatal "Node checksum entry missing"
  (cd /tmp && printf '%s\n' "$checksum_line" | sha256sum -c -)
  rm -rf "${ROOT_DIR}/node-v${NODE_VERSION}"
  mkdir -p "${ROOT_DIR}/node-v${NODE_VERSION}"
  tar -xJf "/tmp/${archive}" --strip-components=1 -C "${ROOT_DIR}/node-v${NODE_VERSION}"
  ln -sfn "${ROOT_DIR}/node-v${NODE_VERSION}/bin/node" /usr/local/bin/node
  ln -sfn "${ROOT_DIR}/node-v${NODE_VERSION}/bin/npm" /usr/local/bin/npm
  ln -sfn "${ROOT_DIR}/node-v${NODE_VERSION}/bin/npx" /usr/local/bin/npx
  rm -f "/tmp/${archive}" /tmp/node-SHASUMS256.txt
}

write_direct_environment() {
  local required=(SUPABASE_URL SUPABASE_SECRET_KEY DIV3RSA_INFERENCE_API_KEY)
  for name in "${required[@]}"; do
    [[ -n "${!name:-}" ]] || return 1
  done
  python3 - "$ENV_FILE" <<'PY'
import os, shlex, sys
path = sys.argv[1]
keys = [
    "SUPABASE_URL", "SUPABASE_SECRET_KEY", "DIV3RSA_INFERENCE_API_KEY",
    "DIV3RSA_RUNTIME_PROVIDER", "DIV3RSA_RUNTIME_PROVIDER_KIND",
    "DIV3RSA_RUNTIME_PROVIDER_PRIORITY", "DIV3RSA_RUNTIME_EXTERNAL_ID",
    "DIV3RSA_RUNTIME_PROFILE", "DIV3RSA_RUNTIME_ALIASES",
    "DIV3RSA_RUNTIME_REGION", "DIV3RSA_RUNTIME_GPU_TYPE",
    "DIV3RSA_RUNTIME_GPU_COUNT", "DIV3RSA_RUNTIME_VRAM_GB",
    "DIV3RSA_INTEGRATION_GATEWAY_URL", "DIV3RSA_RUNTIME_GIT_URL",
    "DIV3RSA_RUNTIME_GIT_REF", "DIV3RSA_LLAMA_CPP_REVISION",
    "DIV3RSA_RUNTIME_PUBLIC_ENDPOINT", "DIV3RSA_RUNTIME_PUBLIC_HEALTH_URL"
]
with open(path, "w", encoding="utf-8") as handle:
    for key in keys:
        value = os.environ.get(key)
        if value:
            handle.write(f"export {key}={shlex.quote(value)}\n")
PY
  chmod 600 "$ENV_FILE"
  return 0
}

exchange_bootstrap_token() {
  [[ -n "${DIV3RSA_BOOTSTRAP_URL:-}" ]] || fatal "DIV3RSA_BOOTSTRAP_URL is required when direct runtime credentials are not supplied"
  [[ -n "${DIV3RSA_BOOTSTRAP_TOKEN:-}" ]] || fatal "DIV3RSA_BOOTSTRAP_TOKEN is required when direct runtime credentials are not supplied"

  log "exchanging short-lived bootstrap credential"
  local response
  response="$(python3 - <<'PY' | curl --fail --silent --show-error --max-time 30 \
      -H 'content-type: application/json' \
      --data-binary @- \
      "$DIV3RSA_BOOTSTRAP_URL"
import json, os
print(json.dumps({"token": os.environ["DIV3RSA_BOOTSTRAP_TOKEN"]}))
PY
  )" || fatal "runtime bootstrap exchange failed"

  RUNTIME_BOOTSTRAP_RESPONSE="$response" python3 - "$ENV_FILE" <<'PY'
import json, os, shlex, sys
path = sys.argv[1]
data = json.loads(os.environ["RUNTIME_BOOTSTRAP_RESPONSE"])
if data.get("contract") != "div3rsa-runtime-v1":
    raise SystemExit("invalid runtime bootstrap contract")
required = {
    "SUPABASE_URL": data.get("supabaseUrl"),
    "SUPABASE_SECRET_KEY": data.get("supabaseSecretKey"),
    "DIV3RSA_INFERENCE_API_KEY": data.get("inferenceApiKey"),
    "DIV3RSA_RUNTIME_PROVIDER": data.get("providerKey"),
    "DIV3RSA_RUNTIME_EXTERNAL_ID": data.get("externalId"),
    "DIV3RSA_RUNTIME_PROFILE": data.get("profile"),
    "DIV3RSA_RUNTIME_GIT_URL": data.get("repositoryUrl"),
    "DIV3RSA_RUNTIME_GIT_REF": data.get("repositoryRef"),
    "DIV3RSA_LLAMA_CPP_REVISION": data.get("llamaCppRevision"),
    "DIV3RSA_INTEGRATION_GATEWAY_URL": data.get("integrationGatewayUrl"),
}
if any(not value for value in required.values()):
    raise SystemExit("runtime bootstrap response missing required values")
aliases = data.get("aliases")
if isinstance(aliases, list) and aliases:
    required["DIV3RSA_RUNTIME_ALIASES"] = ",".join(str(item) for item in aliases)
required["DIV3RSA_RUNTIME_PROVIDER_KIND"] = "managed"
with open(path, "w", encoding="utf-8") as handle:
    for key, value in required.items():
        handle.write(f"export {key}={shlex.quote(str(value))}\n")
PY
  unset response
  chmod 600 "$ENV_FILE"
}

append_environment() {
  local key="$1" value="$2"
  RUNTIME_ENV_KEY="$key" RUNTIME_ENV_VALUE="$value" python3 - "$ENV_FILE" <<'PY'
import os, shlex, sys
with open(sys.argv[1], "a", encoding="utf-8") as handle:
    handle.write(f"export {os.environ['RUNTIME_ENV_KEY']}={shlex.quote(os.environ['RUNTIME_ENV_VALUE'])}\n")
PY
}

sync_repository() {
  local repo_url="${DIV3RSA_RUNTIME_GIT_URL:-https://github.com/heke99/localai.git}"
  local repo_ref="${DIV3RSA_RUNTIME_GIT_REF:-main}"
  if [[ -d "$REPO_DIR/.git" ]]; then
    log "updating runtime repository"
    git -C "$REPO_DIR" fetch --prune --tags origin
  else
    log "cloning runtime repository"
    rm -rf "$REPO_DIR"
    git clone --filter=blob:none "$repo_url" "$REPO_DIR"
    git -C "$REPO_DIR" fetch --prune --tags origin
  fi

  if git -C "$REPO_DIR" rev-parse --verify --quiet "origin/${repo_ref}^{commit}" >/dev/null; then
    git -C "$REPO_DIR" reset --hard "origin/${repo_ref}"
  else
    git -C "$REPO_DIR" fetch origin "$repo_ref"
    git -C "$REPO_DIR" reset --hard FETCH_HEAD
  fi
  git -C "$REPO_DIR" clean -fd
  log "runtime repository pinned to $(git -C "$REPO_DIR" rev-parse HEAD)"
}

build_llama_cpp() {
  local revision="${DIV3RSA_LLAMA_CPP_REVISION:-b10605}"
  if [[ -d "$LLAMA_DIR/.git" ]]; then
    git -C "$LLAMA_DIR" fetch --prune --tags origin
  else
    rm -rf "$LLAMA_DIR"
    git clone --filter=blob:none https://github.com/ggml-org/llama.cpp.git "$LLAMA_DIR"
    git -C "$LLAMA_DIR" fetch --prune --tags origin
  fi
  git -C "$LLAMA_DIR" checkout --detach "$revision"
  log "building llama.cpp ${revision} with CUDA"
  cmake -S "$LLAMA_DIR" -B "$LLAMA_DIR/build" -G Ninja \
    -DCMAKE_BUILD_TYPE=Release \
    -DGGML_CUDA=ON \
    -DLLAMA_CURL=OFF
  cmake --build "$LLAMA_DIR/build" --target llama-server -j "$(nproc)"
  [[ -x "$LLAMA_DIR/build/bin/llama-server" ]] || fatal "llama-server build failed"
}

fetch_model() {
  log "fetching checksum-pinned Qwen V3 Q8 model if needed"
  DIV3RSA_MODEL_DIR="$MODEL_DIR" bash "$REPO_DIR/scripts/fetch_qwen_v3_q8.sh"
}

detect_public_ip() {
  if [[ -n "${DIV3RSA_RUNTIME_PUBLIC_IP:-}" ]]; then
    printf '%s' "$DIV3RSA_RUNTIME_PUBLIC_IP"
    return
  fi
  local attempt ip
  for attempt in {1..12}; do
    ip="$(curl --fail --silent --show-error --max-time 5 https://api.ipify.org 2>/dev/null || true)"
    if [[ "$ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
      printf '%s' "$ip"
      return
    fi
    sleep 5
  done
  return 1
}

configure_public_ingress() {
  if [[ -n "${DIV3RSA_RUNTIME_PUBLIC_ENDPOINT:-}" ]]; then
    [[ "$DIV3RSA_RUNTIME_PUBLIC_ENDPOINT" == https://* ]] || fatal "DIV3RSA_RUNTIME_PUBLIC_ENDPOINT must use HTTPS"
    append_environment DIV3RSA_RUNTIME_PUBLIC_ENDPOINT "$DIV3RSA_RUNTIME_PUBLIC_ENDPOINT"
    append_environment DIV3RSA_RUNTIME_PUBLIC_HEALTH_URL "${DIV3RSA_RUNTIME_PUBLIC_HEALTH_URL:-${DIV3RSA_RUNTIME_PUBLIC_ENDPOINT%/v1}/health}"
    return
  fi

  local ip host
  ip="$(detect_public_ip)" || fatal "could not determine public IPv4; set DIV3RSA_RUNTIME_PUBLIC_IP or provide DIV3RSA_RUNTIME_PUBLIC_ENDPOINT"
  host="${DIV3RSA_RUNTIME_PUBLIC_HOST:-${ip//./-}.${PUBLIC_HOST_SUFFIX}}"
  [[ "$host" =~ ^[A-Za-z0-9.-]+$ ]] || fatal "invalid public runtime hostname"
  log "configuring TLS ingress for ${host}"
  cat >/etc/caddy/Caddyfile <<EOF
${host} {
  encode zstd gzip
  reverse_proxy 127.0.0.1:${MODEL_PORT}
  header {
    -Server
  }
}
EOF
  systemctl enable caddy >/dev/null 2>&1 || true
  systemctl restart caddy
  append_environment DIV3RSA_RUNTIME_PUBLIC_ENDPOINT "https://${host}/v1"
  append_environment DIV3RSA_RUNTIME_PUBLIC_HEALTH_URL "https://${host}/health"
}

install_runtime_service() {
  cat >"$SERVICE_FILE" <<EOF
[Unit]
Description=DIV3RSA provider-neutral AI runtime
After=network-online.target caddy.service
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=${REPO_DIR}
ExecStart=/bin/bash -lc 'set -a; source ${ENV_FILE}; set +a; exec bash ${REPO_DIR}/infra/runtime/start-production.sh'
Restart=always
RestartSec=5
TimeoutStopSec=45
KillMode=mixed
NoNewPrivileges=true
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable div3rsa-runtime >/dev/null
  systemctl restart div3rsa-runtime
}

install_packages
install_node
command -v nvidia-smi >/dev/null 2>&1 || fatal "nvidia-smi is missing; use a CUDA/NVIDIA GPU image"
nvidia-smi >/dev/null 2>&1 || fatal "NVIDIA GPU is not ready"

if ! write_direct_environment; then
  exchange_bootstrap_token
fi
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
unset DIV3RSA_BOOTSTRAP_TOKEN || true

sync_repository
npm --prefix "$REPO_DIR" ci --omit=dev --ignore-scripts
build_llama_cpp
fetch_model

append_environment DIV3RSA_REPO_DIR "$REPO_DIR"
append_environment DIV3RSA_REPOSITORY_ROOT "$REPO_DIR"
append_environment DIV3RSA_LLAMA_SERVER_BIN "$LLAMA_DIR/build/bin/llama-server"
append_environment DIV3RSA_MODEL_DIR "$MODEL_DIR"
append_environment DIV3RSA_MODEL_PATH "$MODEL_DIR/$MODEL_FILENAME"
append_environment DIV3RSA_MODEL_PORT "$MODEL_PORT"
append_environment DIV3RSA_RUNTIME_LOG_DIR "${DIV3RSA_RUNTIME_LOG_DIR:-${ROOT_DIR}/logs}"
append_environment DIV3RSA_INSTALL_NODE_DEPS_ON_BOOT "0"
append_environment DIV3RSA_START_PROVIDER_BASE_SERVICES "0"
configure_public_ingress
install_runtime_service

log "bootstrap complete; runtime supervisor is active"
systemctl --no-pager --full status div3rsa-runtime || true
