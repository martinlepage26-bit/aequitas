#!/usr/bin/env bash
# Build and (re)start the aeq-prod stack and its scheduled operations from the
# checked-out commit. Touches only the aeq-prod compose project.
set -euo pipefail
cd "$(dirname "$0")"
# The Compose control file is never injected into the web app. Runtime and
# migration connections are distinct, owner-only files; never source them.
for file in .env .env.runtime .env.migrations; do
  [[ -f "$file" && ! -L "$file" ]] || { echo "missing regular $file (chmod 600)" >&2; exit 1; }
  [[ "$(stat -c %a "$file")" = 600 ]] || { echo "$file must be chmod 600" >&2; exit 1; }
done
# Accept one unquoted, single-line URL. Inspect key names without logging values.
validate_connection() {
  awk -F= '
    /^[[:space:]]*(#|$)/ { next }
    $0 !~ /^[A-Za-z_][A-Za-z0-9_]*=/ { exit 1 }
    $1 == "DATABASE_URL" { n++; if ($0 !~ /^DATABASE_URL=postgres(ql)?:\/\/[^[:space:]"\047]+$/) exit 1 }
    END { if (n != 1) exit 1 }
  ' "$1"
}
validate_connection .env.runtime || { echo 'runtime DATABASE_URL is missing, duplicated or malformed' >&2; exit 1; }
validate_connection .env.migrations || { echo 'migration DATABASE_URL is missing, duplicated or malformed' >&2; exit 1; }
awk -F= '/^[[:space:]]*(#|$)/ {next} $1 ~ /^(POSTGRES_|PG)/ || $1 ~ /(^|_)MIGRATIONS?(_|$)/ || $1 ~ /(^|_)(OWNER|PURGER|PASSWORD)(_|$)/ || $1 ~ /^(DIRECT_URL|SHADOW_DATABASE_URL)$/ {exit 1}' .env.runtime || {
  echo 'runtime environment contains an operator-only credential or setting' >&2; exit 1;
}
awk -F= '/^[[:space:]]*(#|$)/ {next} $1 != "DATABASE_URL" {exit 1}' .env.migrations || {
  echo 'migration environment must contain only DATABASE_URL' >&2; exit 1;
}
runtime_url="$(awk '/^DATABASE_URL=/ {sub(/^[^=]*=/, ""); print}' .env.runtime)"
migration_url="$(awk '/^DATABASE_URL=/ {sub(/^[^=]*=/, ""); print}' .env.migrations)"
[[ "$runtime_url" != "$migration_url" ]] || { echo 'runtime and migration connections must be separate' >&2; exit 1; }
# This also pins the scheduler's explicitly whitelisted URL to the same runtime
# connection, overriding a stale DATABASE_URL inherited by the operator shell.
export DATABASE_URL="$runtime_url"
unset runtime_url migration_url
retention_enabled="$(awk -F= '$1 == "RETENTION_ENFORCEMENT_ENABLED" {print $2}' .env)"
[[ -n "$retention_enabled" ]] || retention_enabled=false
[[ "$retention_enabled" = true || "$retention_enabled" = false ]] || { echo 'invalid retention enforcement setting' >&2; exit 1; }
export RETENTION_ENFORCEMENT_ENABLED="$retention_enabled"
unset retention_enabled
export RELEASE_SHA="$(git -C ../.. rev-parse HEAD)"
image="aeq-prod-app:$RELEASE_SHA"
docker compose -p aeq-prod build app evidence-parser
services_stopped=false
on_exit() {
  local status=$?
  if [[ "$status" -ne 0 && "$services_stopped" = true ]]; then
    docker compose -p aeq-prod --profile scheduled stop app scheduler || echo 'Could not confirm services stopped; inspect locally.' >&2
    echo 'Deployment failed; app and scheduler were asked to stop. Inspect migration and role state before recovery. No automatic rollback was attempted.' >&2
  fi
}
trap on_exit EXIT
# Old web requests and scheduled writers must be drained before schema changes.
docker compose -p aeq-prod --profile scheduled stop app scheduler
services_stopped=true
docker compose -p aeq-prod up -d --wait --wait-timeout 180 postgres clamav
# A one-off migration process receives only its owner connection, not the web
# environment, evidence volume, parser socket or provider/mail credentials.
docker run --rm --network aeq-prod-net --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --tmpfs /tmp:rw,nosuid,nodev,mode=1777 \
  --env-file .env.migrations --entrypoint node "$image" \
  node_modules/prisma/build/index.js migrate deploy
# Fail closed even if the runtime file was accidentally given an owner URL.
docker run --rm --network aeq-prod-net --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --tmpfs /tmp:rw,nosuid,nodev,mode=1777 \
  --env-file .env.runtime --env RETENTION_ENFORCEMENT_ENABLED --entrypoint node "$image" \
  deploy/ct920/verify-runtime-role.mjs
docker compose -p aeq-prod up -d
healthy=0
for i in $(seq 1 60); do
  body="$(curl -fsS http://127.0.0.1:18310/api/health 2>/dev/null || true)"
  if echo "$body" | grep -q "\"release\":\"$RELEASE_SHA\""; then
    echo "healthy: $body"
    healthy=1
    break
  fi
  sleep 5
done
if [ "$healthy" -ne 1 ]; then
  echo "health did not report $RELEASE_SHA" >&2
  echo "Inspect app diagnostics locally; redact credentials and case data before retaining excerpts." >&2
  exit 1
fi

# Start the worker after the app is confirmed on the migrated release. It
# handles notification retries; case-agent work remains disabled unless the
# full, explicit program and evaluation settings are present.
scheduler_ready_since="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
docker compose -p aeq-prod --profile scheduled up -d scheduler
scheduler_state="$(docker inspect --format '{{.State.Status}}' aeq-prod-scheduler 2>/dev/null || true)"
if [ "$scheduler_state" != "running" ]; then
  echo "scheduled operations did not start with release $RELEASE_SHA" >&2
  exit 1
fi
docker compose -p aeq-prod --profile scheduled exec -T \
  -e "SCHEDULER_READY_SINCE=$scheduler_ready_since" \
  scheduler node node_modules/tsx/dist/cli.mjs scripts/verify-scheduled-ops.ts
echo "scheduled operations are healthy on release $RELEASE_SHA"
