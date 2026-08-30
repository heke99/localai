#!/usr/bin/env bash
set -Eeuo pipefail

log() { printf '[security-supervisor] %s\n' "$*"; }
fatal() { log "$*" >&2; exit 1; }

ENV_FILE="${DIV3RSA_SECURITY_ENV_FILE:-/etc/div3rsa/security-executor.env}"
SERVICE_NAME="${DIV3RSA_SECURITY_SERVICE_NAME:-div3rsa-security-executor.service}"
PID_FILE="${DIV3RSA_SECURITY_PID_FILE:-/run/div3rsa-security-executor.pid}"
LOG_FILE="${DIV3RSA_SECURITY_PROCESS_LOG:-/var/log/div3rsa/security-executor-process.log}"

[[ "${EUID}" -eq 0 ]] || fatal "run as root"
[[ -r "$ENV_FILE" ]] || fatal "executor env unavailable: $ENV_FILE"
id -u div3rsa-security >/dev/null 2>&1 || fatal "div3rsa-security user missing"

systemd_live=0
if [[ -d /run/systemd/system ]] && command -v systemctl >/dev/null 2>&1 && systemctl is-system-running >/dev/null 2>&1; then
  systemd_live=1
fi
if [[ "$systemd_live" == "1" ]]; then
  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME" >/dev/null
  systemctl restart "$SERVICE_NAME"
  log "started through systemd"
  exit 0
fi

command -v setpriv >/dev/null 2>&1 || fatal "setpriv is required on non-systemd hosts"
command -v nohup >/dev/null 2>&1 || fatal "nohup is required on non-systemd hosts"

if [[ -s "$PID_FILE" ]]; then
  old_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ "$old_pid" =~ ^[0-9]+$ ]] && kill -0 "$old_pid" >/dev/null 2>&1; then
    cmdline="$(tr '\0' ' ' <"/proc/${old_pid}/cmdline" 2>/dev/null || true)"
    if [[ "$cmdline" == *"services/security-executor/src/main.ts"* ]]; then
      kill "$old_pid" >/dev/null 2>&1 || true
      for _ in {1..30}; do
        kill -0 "$old_pid" >/dev/null 2>&1 || break
        sleep 0.1
      done
      kill -KILL "$old_pid" >/dev/null 2>&1 || true
    else
      fatal "refusing to kill unrelated PID from $PID_FILE"
    fi
  fi
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
: "${DIV3RSA_REPOSITORY_ROOT:?missing DIV3RSA_REPOSITORY_ROOT}"
: "${DIV3RSA_NODE_BIN:?missing DIV3RSA_NODE_BIN}"
: "${DIV3RSA_SECURITY_EXECUTOR_TOKEN:?missing DIV3RSA_SECURITY_EXECUTOR_TOKEN}"

uid="$(id -u div3rsa-security)"
gid="$(id -g div3rsa-security)"
install -d -o root -g root -m 0755 "$(dirname "$PID_FILE")"
touch "$LOG_FILE"
chown root:div3rsa-security "$LOG_FILE"
chmod 0640 "$LOG_FILE"

umask 077
nohup setpriv \
  --reuid "$uid" \
  --regid "$gid" \
  --init-groups \
  --no-new-privs \
  --bounding-set=-all \
  env -i \
    NODE_ENV="${NODE_ENV:-production}" \
    PATH="${PATH}" \
    LANG="${LANG:-C.UTF-8}" \
    LC_ALL="${LC_ALL:-C.UTF-8}" \
    DIV3RSA_REPOSITORY_ROOT="$DIV3RSA_REPOSITORY_ROOT" \
    DIV3RSA_NODE_BIN="$DIV3RSA_NODE_BIN" \
    DIV3RSA_SECURITY_EXECUTOR_HOST="${DIV3RSA_SECURITY_EXECUTOR_HOST:-127.0.0.1}" \
    DIV3RSA_SECURITY_EXECUTOR_PORT="${DIV3RSA_SECURITY_EXECUTOR_PORT:-7319}" \
    DIV3RSA_SECURITY_EXECUTOR_TOKEN="$DIV3RSA_SECURITY_EXECUTOR_TOKEN" \
    DIV3RSA_SECURITY_AUDIT_LOG="${DIV3RSA_SECURITY_AUDIT_LOG:-/var/log/div3rsa/security-executor.jsonl}" \
    DIV3RSA_SECURITY_MAX_OUTPUT_BYTES="${DIV3RSA_SECURITY_MAX_OUTPUT_BYTES:-512000}" \
    DIV3RSA_SECURITY_WORDLIST="${DIV3RSA_SECURITY_WORDLIST:-}" \
    "$DIV3RSA_REPOSITORY_ROOT/infra/runtime/start-security-executor.sh" \
    >>"$LOG_FILE" 2>&1 </dev/null &
pid=$!
printf '%s\n' "$pid" >"$PID_FILE"
chmod 0644 "$PID_FILE"

sleep 0.3
kill -0 "$pid" >/dev/null 2>&1 || { tail -n 80 "$LOG_FILE" >&2 || true; fatal "executor process exited during startup"; }
cmdline="$(tr '\0' ' ' <"/proc/${pid}/cmdline" 2>/dev/null || true)"
[[ "$cmdline" == *"services/security-executor/src/main.ts"* ]] || fatal "executor PID identity mismatch after startup"
actual_uid="$(awk '/^Uid:/{print $2}' "/proc/${pid}/status" 2>/dev/null || true)"
[[ "$actual_uid" == "$uid" ]] || fatal "executor did not drop to div3rsa-security uid"
grep -Eq '^NoNewPrivs:[[:space:]]+1$' "/proc/${pid}/status" || fatal "executor no-new-privileges missing"
grep -Eq '^CapBnd:[[:space:]]+0+$' "/proc/${pid}/status" || fatal "executor capability bounding set is not empty"
log "started through portable supervisor pid=$pid uid=$uid no_new_privileges=1 bounding_set=empty"
