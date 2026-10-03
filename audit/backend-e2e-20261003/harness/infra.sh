#!/usr/bin/env bash
# Fault injection for the disposable audit infrastructure (loopback only).
#   infra.sh clamd-stop|clamd-start|minio-stop|minio-start|pg-stop|pg-start
set -euo pipefail
: "${AUDIT_SP:?}"; . "$AUDIT_SP/env.sh"
port_up() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
wait_port() { for _ in $(seq 1 "${2:-60}"); do port_up "$1" && return 0; sleep 1; done; return 1; }
case "${1:-}" in
  clamd-stop) docker stop -t 2 aq-audit-clamav >/dev/null; for _ in $(seq 1 20); do port_up 3310 || exit 0; sleep 0.5; done; exit 1 ;;
  clamd-start) docker start aq-audit-clamav >/dev/null; wait_port 3310 120 && for _ in $(seq 1 120); do [ "$(docker inspect -f '{{.State.Health.Status}}' aq-audit-clamav)" = healthy ] && exit 0; sleep 1; done; exit 1 ;;
  minio-stop) pid="$(cat "$SP/minio.pid" 2>/dev/null || true)"; [ -n "$pid" ] && kill "$pid" 2>/dev/null || true; for _ in $(seq 1 20); do port_up 9010 || exit 0; sleep 0.5; done; fuser -k 9010/tcp >/dev/null 2>&1 || true ;;
  minio-start) set -a; . "$SP/minio.env"; set +a
    setsid nohup "$SP/bin/minio" server "$SP/minio-data" --address 127.0.0.1:9010 --console-address 127.0.0.1:9011 > "$SP/logs/minio-run.log" 2>&1 < /dev/null &
    echo $! > "$SP/minio.pid"; wait_port 9010 60 ;;
  pg-stop) runuser -u postgres -- /usr/lib/postgresql/16/bin/pg_ctl -D /var/lib/aq-pg-audit/data -m fast -w stop >/dev/null ;;
  pg-start) runuser -u postgres -- /usr/lib/postgresql/16/bin/pg_ctl -D /var/lib/aq-pg-audit/data -l /var/lib/aq-pg-audit/log/pg.log -o "-p 54329 -k /var/lib/aq-pg-audit/sock -c listen_addresses=127.0.0.1 -c max_connections=200 -c fsync=off -c synchronous_commit=off" -w start >/dev/null ;;
  server-kill) kill -9 "$(cat "$SP/server.pid")" 2>/dev/null || true; for _ in $(seq 1 20); do port_up "${AUDIT_PORT:-3457}" || exit 0; sleep 0.5; done ;; # simulates a crash: no graceful shutdown
  server-start) "$(dirname "$0")/stack.sh" server-start "${2:?s3|local}" "${3:-on}" >/dev/null ;;
  *) echo "usage: $0 clamd-stop|clamd-start|minio-stop|minio-start|pg-stop|pg-start|server-kill|server-start <s3|local> <on|off>" >&2; exit 2 ;;
esac
