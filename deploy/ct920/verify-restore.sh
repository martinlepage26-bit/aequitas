#!/usr/bin/env bash
# Restore a pg_dump -Fc file into aeq-prod-postgres (replacing its contents),
# then check: prisma migrate status, row counts, verify:events, evidence hashes.
# Usage: verify-restore.sh <dump> [evidence.tar]
set -euo pipefail
cd "$(dirname "$0")"
dump="$1"; ev="${2:-}"
docker exec -i aeq-prod-postgres psql -q -U aequitas -d aequitas -c 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;'
docker exec -i aeq-prod-postgres pg_restore -U aequitas -d aequitas --no-owner --no-privileges --exit-on-error < "$dump"
if [ -n "$ev" ]; then
  docker run --rm -i -v aeq-prod-evidence:/data public.ecr.aws/docker/library/postgres:18 sh -c 'rm -rf /data/evidence && mkdir -p /data && tar -C /data -xf - && chown -R 1000:1000 /data' < "$ev"
fi
echo "== migrate status";  docker exec aeq-prod-app npx prisma migrate status
echo "== row counts";      docker exec -i aeq-prod-postgres psql -U aequitas -d aequitas -At -F' ' < row-counts.sql | sort
echo "== verify:events";   docker exec aeq-prod-app npx tsx scripts/verify-events.ts
echo "== evidence hashes"; docker exec aeq-prod-app npx tsx scripts/verify-evidence-files.ts
