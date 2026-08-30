#!/usr/bin/env bash
set -Eeuo pipefail

ACTION="${1:-status}"
SERVICE_NAME="${DIV3RSA_SECURITY_SERVICE_NAME:-div3rsa-security-executor.service}"
SERVICE_USER="${DIV3RSA_SECURITY_SERVICE_USER:-div3rsa-security}"
INSTALL_ROOT="${DIV3RSA_SECURITY_INSTALL_ROOT:-/opt/div3rsa/localai}"
ENV_FILE="${DIV3RSA_SECURITY_ENV_FILE:-/etc/div3rsa/security-executor.env}"
PID_FILE="${DIV3RSA_SECURITY_PID_FILE:-/run/div3rsa/security-executor.pid}"
LOG_FILE="${DIV3RSA_SECURITY_SERVICE_LOG:-/var/log/div3rsa/security-executor-service.log}"
PORT="${DIV3RSA_SECURITY_EXECUTOR_PORT:-7319}"

log() { printf '[security-supervisor] %s\n' "$*"; }
fatal() { log "$*" >&2; exit 1; }

systemd_available() {
  command -v systemctl >/dev/null 2>&1 \
    && [[ "$(cat /proc/1/comm 2>/dev/null || true)" == "systemd" ]] \
    && systemctl show-environment >/dev/null 2>&1
}

pid_alive() {
  local pid="${1:-}"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" >/dev/null 2>&1 || return 1
  [[ "$(ps -o user= -p "$pid" | xargs)" == "$SERVICE_USER" ]] || return 1
  tr '\0' ' ' <"/proc/${pid}/cmdline" | grep -Fq 'services/security-executor/src/main.ts'
}

fallback_pid() {
  if [[ -r "$PID_FILE" ]]; then
    local pid
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if pid_alive "$pid"; then printf '%s\n' "$pid"; return 0; fi
  fi
  pgrep -u "$SERVICE_USER" -f 'services/security-executor/src/main\.ts' | head -n1 || true
}

fallback_stop() {
  local pid
  pid="$(fallback_pid)"
  if [[ -n "$pid" ]]; then
    kill "$pid" >/dev/null 2>&1 || true
    for _ in {1..50}; do
      pid_alive "$pid" || break
      sleep 0.1
    done
    pid_alive "$pid" && kill -KILL "$pid" >/dev/null 2>&1 || true
  fi
  rm -f "$PID_FILE"
}

fallback_start() {
  [[ -r "$ENV_FILE" ]] || fatal "executor env unavailable: $ENV_FILE"
  [[ -x "$INSTALL_ROOT/infra/runtime/start-security-executor.sh" ]] || fatal "executor start script unavailable"
  command -v runuser >/dev/null 2>&1 || fatal "runuser required without systemd"
  command -v setsid >/dev/null 2>&1 || fatal "setsid required without systemd"
  install -d -o root -g root -m 0755 "$(dirname "$PID_FILE")"
  install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0700 "$(dirname "$LOG_FILE")"
  touch "$LOG_FILE"
  chown "$SERVICE_USER:$SERVICE_USER" "$LOG_FILE"
  chmod 0600 "$LOG_FILE"
  fallback_stop
  local launcher_pid
  runuser -u "$SERVICE_USER" -- setsid bash -c '
    set -Eeuo pipefail
    set -a
    source "$1"
    set +a
    exec "$2/infra/runtime/start-security-executor.sh"
  ' bash "$ENV_FILE" "$INSTALL_ROOT" </dev/null >>"$LOG_FILE" 2>&1 &
  launcher_pid=$!
  disown "$launcher_pid" 2>/dev/null || true
  local deadline=$((SECONDS + 10)) pid=""
  while (( SECONDS < deadline )); do
    pid="$(pgrep -u "$SERVICE_USER" -f 'services/security-executor/src/main\.ts' | head -n1 || true)"
    [[ -n "$pid" ]] && break
    sleep 0.2
  done
  [[ -n "$pid" ]] || { tail -n 100 "$LOG_FILE" >&2 || true; fatal "executor process failed to start"; }
  printf '%s\n' "$pid" >"$PID_FILE"
  chmod 0644 "$PID_FILE"
  log "fallback supervisor started pid=$pid user=$SERVICE_USER"
}

case "$ACTION" in
  start|restart)
    if systemd_available; then
      systemctl daemon-reload
      systemctl enable "$SERVICE_NAME" >/dev/null
      systemctl restart "$SERVICE_NAME"
      log "systemd service restarted"
    else
      fallback_start
    fi
    ;;
  stop)
    if systemd_available; then systemctl stop "$SERVICE_NAME" || true; else fallback_stop; fi
    ;;
  status)
    if systemd_available; then
      systemctl is-active --quiet "$SERVICE_NAME"
    else
      pid="$(fallback_pid)"
      [[ -n "$pid" ]] && pid_alive "$pid"
    fi
    ;;
  logs)
    if systemd_available; then journalctl -u "$SERVICE_NAME" -n 120 --no-pager; else tail -n 120 "$LOG_FILE"; fi
    ;;
  *) fatal "usage: $0 {start|restart|stop|status|logs}" ;;
esac
