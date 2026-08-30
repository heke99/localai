#!/usr/bin/env bash
set -Eeuo pipefail

SERVICE_NAME="${DIV3RSA_SECURITY_SERVICE_NAME:-div3rsa-security-executor.service}"
PID_FILE="${DIV3RSA_SECURITY_PID_FILE:-/run/div3rsa-security-executor.pid}"
PORT="${DIV3RSA_SECURITY_EXECUTOR_PORT:-7319}"

if [[ -d /run/systemd/system ]] && command -v systemctl >/dev/null 2>&1 && systemctl is-system-running >/dev/null 2>&1; then
  systemctl is-active --quiet "$SERVICE_NAME"
else
  [[ -s "$PID_FILE" ]] || { echo "security executor pid file missing" >&2; exit 1; }
  pid="$(cat "$PID_FILE")"
  [[ "$pid" =~ ^[0-9]+$ ]] || { echo "invalid security executor pid" >&2; exit 1; }
  kill -0 "$pid" >/dev/null 2>&1 || { echo "security executor process not running" >&2; exit 1; }
  cmdline="$(tr '\0' ' ' <"/proc/${pid}/cmdline" 2>/dev/null || true)"
  [[ "$cmdline" == *"services/security-executor/src/main.ts"* ]] || { echo "security executor pid identity mismatch" >&2; exit 1; }
  expected_uid="$(id -u div3rsa-security)"
  actual_uid="$(awk '/^Uid:/{print $2}' "/proc/${pid}/status")"
  [[ "$actual_uid" == "$expected_uid" ]] || { echo "security executor uid mismatch" >&2; exit 1; }
  grep -Eq '^NoNewPrivs:[[:space:]]+1$' "/proc/${pid}/status" || { echo "security executor no-new-privileges missing" >&2; exit 1; }
  grep -Eq '^CapBnd:[[:space:]]+0+$' "/proc/${pid}/status" || { echo "security executor capability bounding set not empty" >&2; exit 1; }
fi

curl --fail --silent --show-error --max-time 3 "http://127.0.0.1:${PORT}/health" >/dev/null
echo "SECURITY_EXECUTOR_ACTIVE_OK"
