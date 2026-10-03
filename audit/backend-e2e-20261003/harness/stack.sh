#!/usr/bin/env bash
# Audit stack control. Everything here is disposable and bound to loopback.
#   stack.sh stub-start | stub-stop
#   stack.sh server-start <s3|local> <mail:on|off>      (production-mode `next start`, dedicated audit DB)
#   stack.sh server-stop
#   stack.sh status
# Requires AUDIT_SP (scratch dir holding env.sh, stack.env and generated synthetic secrets).
set -euo pipefail
: "${AUDIT_SP:?AUDIT_SP must point at the scratch directory}"
. "$AUDIT_SP/env.sh"
HARNESS=/home/user/aequitas/audit/backend-e2e-20261003/harness
REPO=/home/user/aequitas
PORT=${AUDIT_PORT:-3457}
STUBPORT=${AUDIT_STUB_PORT:-4581}
STUB="http://127.0.0.1:${STUBPORT}"

port_up() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

wait_for() { # url, tries
  for _ in $(seq 1 "${2:-60}"); do curl -fsS -o /dev/null -m 2 "$1" 2>/dev/null && return 0; sleep 1; done
  return 1
}

stub_start() {
  stub_stop
  AUDIT_STUB_PORT=$STUBPORT setsid nohup node "$HARNESS/stub.mjs" > "$SP/logs/stub.log" 2>&1 < /dev/null &
  echo $! > "$SP/stub.pid"
  wait_for "$STUB/__health" 20 && echo "stub up on $STUBPORT" || { echo "stub failed"; tail -5 "$SP/logs/stub.log"; exit 1; }
}
stub_stop() { [ -f "$SP/stub.pid" ] && kill "$(cat "$SP/stub.pid")" 2>/dev/null || true; rm -f "$SP/stub.pid"; }

server_stop() {
  if [ -f "$SP/server.pid" ]; then kill "$(cat "$SP/server.pid")" 2>/dev/null || true; fi
  for _ in $(seq 1 20); do port_up "$PORT" || break; sleep 0.5; done
  if port_up "$PORT"; then fuser -k "${PORT}/tcp" >/dev/null 2>&1 || true; sleep 1; fi
  rm -f "$SP/server.pid"
}

server_start() {
  local storage="${1:?s3|local}" mail="${2:?on|off}"
  server_stop
  set -a; . "$SP/stack.env"; set +a
  export AUDIT_STUB_URL="$STUB" AUDIT_DENY_LOG="$SP/logs/outbound-denied.log"
  export NODE_OPTIONS="${NODE_OPTIONS:-} --import $HARNESS/preload.mjs"
  export PORT HOSTNAME=127.0.0.1 NODE_ENV=production
  export WEBAUTHN_RP_ID=aequitas-audit.invalid WEBAUTHN_ORIGIN=https://aequitas-audit.invalid WEBAUTHN_RP_NAME=Aequitas
  export ANTHROPIC_API_KEY=sk-ant-audit-synthetic-not-a-real-key ANTHROPIC_MODEL=stub-model-1 ANTHROPIC_BASE_URL="$STUB/anthropic"
  unset LEGIPRO_API_URL LEGIPRO_API_TOKEN STORAGE_LOCAL_DIR
  if [ "$mail" = on ]; then
    export RESEND_API_KEY=re_audit_synthetic_not_a_real_key EMAIL_FROM=aequitas@pharos-ai.ca EMAIL_REPLY_TO=aequitas@pharos-ai.ca APP_URL=https://aequitas-audit.invalid
  else
    unset RESEND_API_KEY EMAIL_FROM EMAIL_REPLY_TO
    export APP_URL=https://aequitas-audit.invalid
  fi
  if [ "$storage" = local ]; then
    mkdir -p "$SP/storage-local"; export STORAGE_LOCAL_DIR="$SP/storage-local"
    unset STORAGE_ENDPOINT
  fi
  cd "$REPO"
  setsid nohup "$HARNESS/with-db.sh" aequitas_audit_test -- node "$REPO/node_modules/next/dist/bin/next" start -p "$PORT" -H 127.0.0.1 \
    > "$SP/logs/server-${storage}-${mail}.log" 2>&1 < /dev/null &
  echo $! > "$SP/server.pid"
  wait_for "http://127.0.0.1:${PORT}/api/health" 60 && echo "server up: storage=$storage mail=$mail port=$PORT (production mode)" || { echo "server failed to start"; tail -20 "$SP/logs/server-${storage}-${mail}.log"; exit 1; }
}

status() {
  for p in "$PORT:next-start(prod)" "$STUBPORT:audit-stub" "9010:minio" "3310:clamd" "54329:postgres"; do
    port="${p%%:*}"; name="${p#*:}"
    if port_up "$port"; then echo "UP   ${name} :${port}"; else echo "DOWN ${name} :${port}"; fi
  done
}

case "${1:-}" in
  stub-start) stub_start ;;
  stub-stop) stub_stop ;;
  server-start) server_start "${2:-}" "${3:-}" ;;
  server-stop) server_stop ;;
  status) status ;;
  *) echo "usage: $0 stub-start|stub-stop|server-start <s3|local> <on|off>|server-stop|status" >&2; exit 2 ;;
esac
