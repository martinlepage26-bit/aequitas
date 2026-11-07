#!/usr/bin/env bash
# Build and (re)start the aeq-prod stack and its scheduled operations from the
# checked-out commit. Touches only the aeq-prod compose project.
set -euo pipefail
cd "$(dirname "$0")"
test -f .env || { echo "missing deploy/ct920/.env (chmod 600)"; exit 1; }
[ "$(stat -c %a .env)" = 600 ] || { echo ".env must be chmod 600"; exit 1; }
export RELEASE_SHA="$(git -C ../.. rev-parse HEAD)"
docker compose -p aeq-prod build app
if [ -n "$(docker compose -p aeq-prod --profile scheduled ps -a -q scheduler)" ]; then
  docker compose -p aeq-prod --profile scheduled stop scheduler
fi
docker compose -p aeq-prod up -d postgres clamav
docker compose -p aeq-prod run --rm --no-deps app npx prisma migrate deploy
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
  docker compose -p aeq-prod logs --tail 80 app
  exit 1
fi

# Start the worker after the app is confirmed on the migrated release. It
# handles notification retries; case-agent work remains disabled unless the
# full, explicit program and evaluation settings are present.
docker compose -p aeq-prod --profile scheduled up -d scheduler
scheduler_state="$(docker inspect --format '{{.State.Status}}' aeq-prod-scheduler 2>/dev/null || true)"
if [ "$scheduler_state" != "running" ]; then
  echo "scheduled operations did not start with release $RELEASE_SHA" >&2
  exit 1
fi
echo "scheduled operations started"
