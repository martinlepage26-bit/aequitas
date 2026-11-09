#!/usr/bin/env bash
# Destructively replace production database contents, optionally replace the
# evidence volume, then verify the restored production data. Never a dry-run.
# Usage: verify-restore.sh --confirm-production-replacement <dump> [evidence.tar]
set -euo pipefail

usage() {
  printf 'Usage: %s --confirm-production-replacement <dump> [evidence.tar]\n' "$0" >&2
}

refuse() {
  printf 'Refusing production restore: %s\n' "$1" >&2
  exit 1
}

if [[ "${1:-}" != "--confirm-production-replacement" ]]; then
  printf '%s\n' 'This command replaces the live Aequitas production database.' >&2
  printf '%s\n' 'It can also replace all production evidence files.' >&2
  printf '%s\n' 'An explicit flag and typed interactive confirmation are required.' >&2
  usage
  exit 64
fi
shift

if [[ "$#" -lt 1 || "$#" -gt 2 ]]; then
  usage
  exit 64
fi

resolve_input_file() {
  local supplied="$1"
  local parent
  parent="$(cd -- "$(dirname -- "$supplied")" && pwd -P)" || return 1
  local resolved="$parent/$(basename -- "$supplied")"
  [[ -f "$resolved" && -r "$resolved" ]] || return 1
  printf '%s\n' "$resolved"
}

dump="$(resolve_input_file "$1")" || refuse 'the database dump must be a readable regular file.'
ev=""
if [[ "$#" -eq 2 ]]; then
  ev="$(resolve_input_file "$2")" || refuse 'the evidence archive must be a readable regular file.'
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$script_dir"

if ! db_running="$(docker inspect --format '{{.State.Running}}' aeq-prod-postgres 2>/dev/null)"; then
  refuse 'the production PostgreSQL container is unavailable.'
fi
[[ "$db_running" == "true" ]] || refuse 'the production PostgreSQL container is not running.'

if ! db_health="$(docker inspect --format '{{.State.Health.Status}}' aeq-prod-postgres 2>/dev/null)"; then
  refuse 'the production PostgreSQL health state is unavailable.'
fi
[[ "$db_health" == "healthy" ]] || refuse 'the production PostgreSQL container is not healthy.'

if ! app_running="$(docker inspect --format '{{.State.Running}}' aeq-prod-app 2>/dev/null)"; then
  refuse 'the production app container is unavailable; confirm the deployment state manually.'
fi
[[ "$app_running" == "false" ]] || refuse 'stop the production app before restoring; it must not write during replacement.'

if scheduler_running="$(docker inspect --format '{{.State.Running}}' aeq-prod-scheduler 2>/dev/null)"; then
  [[ "$scheduler_running" == "false" ]] || refuse 'stop the production scheduler before restoring; it must not write during replacement.'
fi

if ! docker run --rm -i --network none --entrypoint pg_restore public.ecr.aws/docker/library/postgres:18 --list < "$dump" >/dev/null 2>&1; then
  refuse 'the database dump is not a readable PostgreSQL custom-format archive.'
fi
if [[ -n "$ev" ]] && ! docker run --rm -i --network none --entrypoint tar public.ecr.aws/docker/library/postgres:18 -tf - < "$ev" >/dev/null 2>&1; then
  refuse 'the evidence archive is unreadable; production data has not been replaced.'
fi

if ! app_image="$(docker inspect --format '{{.Config.Image}}' aeq-prod-app 2>/dev/null)" || [[ "$app_image" != aeq-prod-app:* ]]; then
  refuse 'the stopped production app image could not be identified safely.'
fi
docker volume inspect aeq-prod-evidence >/dev/null 2>&1 || refuse 'the production evidence volume is unavailable.'

if [[ ! -t 0 && ! -t 1 && ! -t 2 ]]; then
  refuse 'an interactive terminal is required for the production replacement confirmation.'
fi
if ! { : >/dev/tty; } 2>/dev/null; then
  refuse 'an interactive terminal is required for the production replacement confirmation.'
fi

confirmation='REPLACE AEQUITAS PRODUCTION DATABASE'
if [[ -n "$ev" ]]; then
  confirmation+=' AND EVIDENCE'
fi
printf '%s\n' 'WARNING: this overwrites the live production database.' >&2
if [[ -n "$ev" ]]; then
  printf '%s\n' 'It also replaces the complete production evidence directory.' >&2
else
  printf '%s\n' 'The production evidence directory will remain in place.' >&2
fi
printf 'Type exactly "%s" to continue: ' "$confirmation" > /dev/tty
if ! IFS= read -r typed_confirmation < /dev/tty || [[ "$typed_confirmation" != "$confirmation" ]]; then
  refuse 'the typed production replacement confirmation did not match.'
fi

if ! database_url="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' aeq-prod-app 2>/dev/null | awk -F= '$1 == "DATABASE_URL" { sub(/^[^=]*=/, ""); print; exit }')"; then
  refuse 'the production database connection setting could not be read for the one-off verifier.'
fi
[[ -n "$database_url" && "$database_url" != *$'\n'* && "$database_url" != *$'\r'* ]] || refuse 'the production database connection setting is missing or malformed.'
umask 077
verify_env="$(mktemp "${TMPDIR:-/tmp}/aequitas-restore-verify.XXXXXX")"
printf 'DATABASE_URL=%s\nSTORAGE_LOCAL_DIR=/data/evidence\n' "$database_url" > "$verify_env"
unset database_url
trap 'rm -f -- "$verify_env"' EXIT

printf '%s\n' 'Replacing the production database schema.'
docker exec -i aeq-prod-postgres psql -q -U aequitas -d aequitas -c 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;'
docker exec -i aeq-prod-postgres pg_restore -U aequitas -d aequitas --no-owner --no-privileges --exit-on-error < "$dump"
if [[ -n "$ev" ]]; then
  printf '%s\n' 'Replacing the production evidence directory.'
  docker run --rm -i -v aeq-prod-evidence:/data public.ecr.aws/docker/library/postgres:18 sh -c 'rm -rf /data/evidence && mkdir -p /data && tar -C /data -xf - && chown -R 1000:1000 /data' < "$ev"
fi

run_verifier() {
  docker run --rm --network aeq-prod-net --env-file "$verify_env" \
    --mount type=volume,source=aeq-prod-evidence,target=/data,readonly \
    --entrypoint "$1" "$app_image" "${@:2}"
}

printf '%s\n' '== migrate status (one-off verifier; production app remains stopped)'
run_verifier npx --no-install prisma migrate status
printf '%s\n' '== row counts'
docker exec -i aeq-prod-postgres psql -U aequitas -d aequitas -At -F' ' < row-counts.sql | sort
printf '%s\n' '== verify:events (one-off verifier; production app remains stopped)'
run_verifier node node_modules/tsx/dist/cli.mjs scripts/verify-events.ts
printf '%s\n' '== evidence hashes (read-only volume; production app remains stopped)'
run_verifier node node_modules/tsx/dist/cli.mjs scripts/verify-evidence-files.ts
printf '%s\n' 'Restore verification complete. The production app and scheduler remain stopped.'
