#!/usr/bin/env bash
# Build and (re)start the aeq-prod stack from the checked-out commit.
# Touches only the aeq-prod compose project.
set -euo pipefail
cd "$(dirname "$0")"
test -f .env || { echo "missing deploy/ct920/.env (chmod 600)"; exit 1; }
[ "$(stat -c %a .env)" = 600 ] || { echo ".env must be chmod 600"; exit 1; }
export RELEASE_SHA="$(git -C ../.. rev-parse HEAD)"
docker compose -p aeq-prod build app
docker compose -p aeq-prod up -d
for i in $(seq 1 60); do
  body="$(curl -fsS http://127.0.0.1:18310/api/health 2>/dev/null || true)"
  if echo "$body" | grep -q "\"release\":\"$RELEASE_SHA\""; then echo "healthy: $body"; exit 0; fi
  sleep 5
done
echo "health did not report $RELEASE_SHA"; docker compose -p aeq-prod logs --tail 80 app; exit 1
