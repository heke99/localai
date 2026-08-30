#!/usr/bin/env bash
set -euo pipefail

ROOT="${DIV3RSA_REPOSITORY_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
NODE_BIN="${DIV3RSA_NODE_BIN:-$(command -v node || true)}"

if [[ -z "${NODE_BIN}" || ! -x "${NODE_BIN}" ]]; then
  echo "security-executor: node runtime unavailable" >&2
  exit 1
fi

: "${DIV3RSA_SECURITY_EXECUTOR_TOKEN:?DIV3RSA_SECURITY_EXECUTOR_TOKEN is required}"

required_tools=(curl openssl dig nmap nuclei ffuf)
for tool in "${required_tools[@]}"; do
  if ! command -v "${tool}" >/dev/null 2>&1; then
    echo "security-executor: required tool missing: ${tool}" >&2
    exit 1
  fi
done

AUDIT_LOG="${DIV3RSA_SECURITY_AUDIT_LOG:-/var/log/div3rsa/security-executor.jsonl}"
mkdir -p "$(dirname "${AUDIT_LOG}")"
touch "${AUDIT_LOG}"
chmod 600 "${AUDIT_LOG}"

if [[ -n "${DIV3RSA_SECURITY_WORDLIST:-}" && ! -r "${DIV3RSA_SECURITY_WORDLIST}" ]]; then
  echo "security-executor: configured wordlist is not readable" >&2
  exit 1
fi

export DIV3RSA_REPOSITORY_ROOT="${ROOT}"
exec "${NODE_BIN}" --experimental-transform-types --import "${ROOT}/infra/runpod/native-typescript-register.mjs" "${ROOT}/services/security-executor/src/main.ts"
