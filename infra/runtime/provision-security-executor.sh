#!/usr/bin/env bash
set -Eeuo pipefail

log() { printf '[security-provision] %s\n' "$*"; }
fatal() { log "$*" >&2; exit 1; }

SOURCE_ROOT="${DIV3RSA_REPOSITORY_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
INSTALL_ROOT="${DIV3RSA_SECURITY_INSTALL_ROOT:-/opt/div3rsa/localai}"
TOOLS_ROOT="${DIV3RSA_SECURITY_TOOLS_ROOT:-/opt/div3rsa/security-tools}"
ENV_DIR="${DIV3RSA_SECURITY_ENV_DIR:-/etc/div3rsa}"
ENV_FILE="${DIV3RSA_SECURITY_ENV_FILE:-${ENV_DIR}/security-executor.env}"
WORKER_ENV_FILE="${DIV3RSA_AGENT_WORKER_ENV_FILE:-/root/autodl-tmp/localai/secrets/gpuhub-worker.env}"
SERVICE_NAME="${DIV3RSA_SECURITY_SERVICE_NAME:-div3rsa-security-executor.service}"
PORT="${DIV3RSA_SECURITY_EXECUTOR_PORT:-7319}"
NUCLEI_VERSION="${DIV3RSA_NUCLEI_VERSION:-v3.4.10}"
FFUF_VERSION="${DIV3RSA_FFUF_VERSION:-v2.1.0}"
GO_VERSION="${DIV3RSA_SECURITY_GO_VERSION:-1.24.1}"
GO_ROOT="${DIV3RSA_SECURITY_GO_ROOT:-${TOOLS_ROOT}/go-${GO_VERSION}}"
GO_SHA256_AMD64="cb2396bae64183cdccf81a9a6df0aea3bce9511fc21469fb89a0c00470088073"
GO_SHA256_ARM64="8df5750ffc0281017fb6070fba450f5d22b600a02081dceef47966ffaf36a3af"
WORDLIST_SOURCE="${DIV3RSA_SECURITY_WORDLIST_SOURCE:-}"
WORDLIST_TARGET="${DIV3RSA_SECURITY_WORDLIST_TARGET:-${TOOLS_ROOT}/wordlists/common.txt}"
AUDIT_LOG="${DIV3RSA_SECURITY_AUDIT_LOG:-/var/log/div3rsa/security-executor.jsonl}"

[[ "${EUID}" -eq 0 ]] || fatal "run as root on the runtime host"
[[ -f "${SOURCE_ROOT}/services/security-executor/src/main.ts" ]] || fatal "security executor source missing under ${SOURCE_ROOT}"
[[ -f "${SOURCE_ROOT}/infra/runpod/native-typescript-register.mjs" ]] || fatal "native TypeScript register missing"
[[ -f "${SOURCE_ROOT}/infra/runtime/div3rsa-security-executor.service" ]] || fatal "systemd unit missing"
[[ -f "${SOURCE_ROOT}/infra/runtime/security-executor-supervisor.sh" ]] || fatal "security supervisor missing"
command -v openssl >/dev/null 2>&1 || fatal "openssl is required to generate executor credentials"

if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  log "ensuring bounded security runtime dependencies"
  apt-get update -y >/dev/null
  apt-get install -y --no-install-recommends ca-certificates curl openssl dnsutils nmap iproute2 tar util-linux procps >/dev/null
fi

for tool in curl openssl dig nmap ip tar sha256sum runuser setsid pgrep; do
  command -v "$tool" >/dev/null 2>&1 || fatal "required provisioning dependency unavailable: ${tool}"
done

if ! id -u div3rsa-security >/dev/null 2>&1; then
  log "creating locked service account"
  useradd --system --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin div3rsa-security
fi

install -d -o root -g root -m 0755 "${INSTALL_ROOT}/infra/runtime" "${INSTALL_ROOT}/infra/runpod" "${INSTALL_ROOT}/services/security-executor/src"
install -d -o root -g root -m 0755 "${TOOLS_ROOT}/bin" "${TOOLS_ROOT}/wordlists"
install -d -o root -g div3rsa-security -m 0750 "${ENV_DIR}"
install -d -o div3rsa-security -g div3rsa-security -m 0700 "$(dirname "${AUDIT_LOG}")"

audit_dir="$(dirname "${AUDIT_LOG}")"
touch "${AUDIT_LOG}"
chown div3rsa-security:div3rsa-security "${AUDIT_LOG}" "$audit_dir"
chmod 0700 "$audit_dir"
chmod 0600 "${AUDIT_LOG}"

log "installing minimal immutable executor snapshot"
install -o root -g root -m 0755 "${SOURCE_ROOT}/infra/runtime/start-security-executor.sh" "${INSTALL_ROOT}/infra/runtime/start-security-executor.sh"
install -o root -g root -m 0755 "${SOURCE_ROOT}/infra/runtime/security-executor-supervisor.sh" "${INSTALL_ROOT}/infra/runtime/security-executor-supervisor.sh"
install -o root -g root -m 0644 "${SOURCE_ROOT}/infra/runpod/native-typescript-register.mjs" "${INSTALL_ROOT}/infra/runpod/native-typescript-register.mjs"
install -o root -g root -m 0644 "${SOURCE_ROOT}/services/security-executor/src/main.ts" "${INSTALL_ROOT}/services/security-executor/src/main.ts"
install -o root -g root -m 0644 "${SOURCE_ROOT}/services/security-executor/src/runtime.ts" "${INSTALL_ROOT}/services/security-executor/src/runtime.ts"

arch="$(uname -m)"
case "$arch" in
  x86_64|amd64)
    go_arch=amd64
    go_sha="$GO_SHA256_AMD64"
    ;;
  aarch64|arm64)
    go_arch=arm64
    go_sha="$GO_SHA256_ARM64"
    ;;
  *) fatal "unsupported architecture for pinned Go toolchain: $arch" ;;
esac
GO_BIN="${GO_ROOT}/bin/go"
if [[ ! -x "$GO_BIN" ]] || [[ "$($GO_BIN version 2>/dev/null || true)" != "go version go${GO_VERSION} "* ]]; then
  log "installing pinned Go ${GO_VERSION} (${go_arch})"
  archive="$(mktemp)"
  extract_dir="$(mktemp -d)"
  trap 'rm -f "${archive:-}"; rm -rf "${extract_dir:-}"' RETURN
  curl --fail --location --silent --show-error --retry 3 --max-time 180 \
    "https://go.dev/dl/go${GO_VERSION}.linux-${go_arch}.tar.gz" -o "$archive"
  printf '%s  %s\n' "$go_sha" "$archive" | sha256sum -c - >/dev/null || fatal "pinned Go checksum mismatch"
  tar -C "$extract_dir" -xzf "$archive"
  rm -rf "$GO_ROOT"
  mv "$extract_dir/go" "$GO_ROOT"
  chmod -R a+rX "$GO_ROOT"
  rm -f "$archive"
  rm -rf "$extract_dir"
  trap - RETURN
fi
[[ "$($GO_BIN version)" == "go version go${GO_VERSION} "* ]] || fatal "pinned Go runtime version mismatch"

export GOBIN="${TOOLS_ROOT}/bin"
export PATH="${GO_ROOT}/bin:${PATH}"
if [[ ! -x "${TOOLS_ROOT}/bin/nuclei" ]] || [[ "$("${TOOLS_ROOT}/bin/nuclei" -version 2>&1 | tr -d '[:space:]')" != *"${NUCLEI_VERSION#v}"* ]]; then
  log "installing pinned nuclei ${NUCLEI_VERSION}"
  "$GO_BIN" install "github.com/projectdiscovery/nuclei/v3/cmd/nuclei@${NUCLEI_VERSION}"
fi
if [[ ! -x "${TOOLS_ROOT}/bin/ffuf" ]] || [[ "$("${TOOLS_ROOT}/bin/ffuf" -V 2>&1 | tr -d '[:space:]')" != *"${FFUF_VERSION#v}"* ]]; then
  log "installing pinned ffuf ${FFUF_VERSION}"
  "$GO_BIN" install "github.com/ffuf/ffuf/v2@${FFUF_VERSION}"
fi
chmod 0755 "${TOOLS_ROOT}/bin/nuclei" "${TOOLS_ROOT}/bin/ffuf"

if [[ -n "${WORDLIST_SOURCE}" ]]; then
  [[ -r "${WORDLIST_SOURCE}" ]] || fatal "configured wordlist source is not readable: ${WORDLIST_SOURCE}"
  install -o root -g div3rsa-security -m 0640 "${WORDLIST_SOURCE}" "${WORDLIST_TARGET}"
fi

TOKEN=""
if [[ -f "${ENV_FILE}" ]]; then
  TOKEN="$(sed -n 's/^DIV3RSA_SECURITY_EXECUTOR_TOKEN=//p' "${ENV_FILE}" | tail -n 1)"
fi
if [[ -z "${TOKEN}" ]]; then
  TOKEN="$(openssl rand -hex 32)"
fi

NODE_BIN="${DIV3RSA_NODE_BIN:-$(command -v node || true)}"
[[ -n "${NODE_BIN}" && -x "${NODE_BIN}" ]] || fatal "Node runtime is required"

umask 077
cat >"${ENV_FILE}" <<EOF
DIV3RSA_REPOSITORY_ROOT=${INSTALL_ROOT}
DIV3RSA_NODE_BIN=${NODE_BIN}
DIV3RSA_SECURITY_EXECUTOR_HOST=127.0.0.1
DIV3RSA_SECURITY_EXECUTOR_PORT=${PORT}
DIV3RSA_SECURITY_EXECUTOR_TOKEN=${TOKEN}
DIV3RSA_SECURITY_AUDIT_LOG=${AUDIT_LOG}
DIV3RSA_SECURITY_MAX_OUTPUT_BYTES=512000
PATH=${TOOLS_ROOT}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
EOF
if [[ -r "${WORDLIST_TARGET}" ]]; then
  printf 'DIV3RSA_SECURITY_WORDLIST=%s\n' "${WORDLIST_TARGET}" >>"${ENV_FILE}"
fi
chown root:div3rsa-security "${ENV_FILE}"
chmod 0640 "${ENV_FILE}"

if [[ -d /etc/systemd/system ]]; then
  install -o root -g root -m 0644 "${SOURCE_ROOT}/infra/runtime/div3rsa-security-executor.service" "/etc/systemd/system/${SERVICE_NAME}"
fi

upsert_env() {
  local key="$1" value="$2" file="$3" tmp
  mkdir -p "$(dirname "$file")"
  touch "$file"
  chmod 0600 "$file"
  tmp="$(mktemp)"
  grep -v "^${key}=" "$file" >"$tmp" || true
  printf '%s=%s\n' "$key" "$value" >>"$tmp"
  cat "$tmp" >"$file"
  rm -f "$tmp"
}

log "wiring agent worker to loopback executor"
upsert_env DIV3RSA_SECURITY_TOOL_RUNTIME_ENABLED 1 "${WORKER_ENV_FILE}"
upsert_env DIV3RSA_SECURITY_EXECUTOR_URL "http://127.0.0.1:${PORT}" "${WORKER_ENV_FILE}"
upsert_env DIV3RSA_SECURITY_EXECUTOR_TOKEN "${TOKEN}" "${WORKER_ENV_FILE}"

DIV3RSA_SECURITY_SERVICE_NAME="$SERVICE_NAME" \
DIV3RSA_SECURITY_INSTALL_ROOT="$INSTALL_ROOT" \
DIV3RSA_SECURITY_ENV_FILE="$ENV_FILE" \
  bash "${INSTALL_ROOT}/infra/runtime/security-executor-supervisor.sh" restart

health_url="http://127.0.0.1:${PORT}/health"
deadline=$((SECONDS + ${DIV3RSA_SECURITY_BOOT_TIMEOUT_SECONDS:-45}))
until curl --fail --silent --show-error --max-time 2 "${health_url}" >/dev/null 2>&1; do
  if (( SECONDS >= deadline )); then
    DIV3RSA_SECURITY_SERVICE_NAME="$SERVICE_NAME" \
    DIV3RSA_SECURITY_INSTALL_ROOT="$INSTALL_ROOT" \
    DIV3RSA_SECURITY_ENV_FILE="$ENV_FILE" \
      bash "${INSTALL_ROOT}/infra/runtime/security-executor-supervisor.sh" logs || true
    fatal "security executor failed health check"
  fi
  sleep 1
done

DIV3RSA_SECURITY_SERVICE_NAME="$SERVICE_NAME" \
DIV3RSA_SECURITY_INSTALL_ROOT="$INSTALL_ROOT" \
DIV3RSA_SECURITY_ENV_FILE="$ENV_FILE" \
  bash "${INSTALL_ROOT}/infra/runtime/security-executor-supervisor.sh" status || fatal "security executor supervisor status failed"
log "security executor healthy on loopback:${PORT}"
log "worker env wired at ${WORKER_ENV_FILE}; restart the agent worker after this provisioning step"
printf 'DIV3RSA_SECURITY_EXECUTOR_URL=http://127.0.0.1:%s\n' "${PORT}"
