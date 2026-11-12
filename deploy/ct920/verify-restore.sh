#!/usr/bin/env bash
# Destructively replace production database contents, optionally replace the
# evidence volume, then verify the restored production data. Never a dry-run.
# Usage: verify-restore.sh --confirm-production-replacement --purger-role <existing-role> <dump> [evidence.tar]
set -euo pipefail

usage() {
  printf 'Usage: %s --confirm-production-replacement --purger-role <existing-role> <dump> [evidence.tar]\n' "$0" >&2
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
[[ "${1:-}" == --purger-role && -n "${2:-}" ]] || refuse 'an explicit existing --purger-role is required; no role name is assumed.'
purger_role="$2"
[[ "$purger_role" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || refuse 'the purger role must be a simple PostgreSQL identifier.'
shift 2

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
for role_sql in validate-restore-roles.sql provision-purger.sql grant-restored-runtime.sql; do
  [[ -r "../retention/$role_sql" ]] || refuse 'reviewed restore role SQL is unavailable.'
done

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

if ! app_image_tag="$(docker inspect --format '{{.Config.Image}}' aeq-prod-app 2>/dev/null)" || [[ "$app_image_tag" != aeq-prod-app:* ]]; then
  refuse 'the stopped production app image could not be identified safely.'
fi
app_image="$(docker inspect --format '{{.Image}}' aeq-prod-app)" || refuse 'the stopped app image identity is unavailable.'
[[ "$app_image" =~ ^sha256:[a-f0-9]{64}$ ]] || refuse 'the stopped app image identity is invalid.'
docker volume inspect aeq-prod-evidence >/dev/null 2>&1 || refuse 'the production evidence volume is unavailable.'
docker volume inspect aeq-prod-retention-ledger >/dev/null 2>&1 || refuse 'the independent retention ledger volume is unavailable; do not restore it from the case backup.'

if ! database_url="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' aeq-prod-app 2>/dev/null | awk -F= '$1 == "DATABASE_URL" { sub(/^[^=]*=/, ""); print; exit }')"; then
  refuse 'the production database connection setting could not be read for the one-off verifier.'
fi
[[ -n "$database_url" && "$database_url" != *$'\n'* && "$database_url" != *$'\r'* ]] || refuse 'the production database connection setting is missing or malformed.'
if ! genesis="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' aeq-prod-app 2>/dev/null | awk -F= '$1 == "HASH_CHAIN_GENESIS" { found=1; sub(/^[^=]*=/, ""); print; exit } END { if (!found) printf "%064d\n", 0 }')"; then
  refuse 'the production event-chain genesis setting could not be read.'
fi
# Match the application's documented default only when the setting is absent.
[[ "$genesis" =~ ^[a-fA-F0-9]{64}$ ]] || refuse 'the production event-chain genesis is malformed.'
umask 077
verify_env="$(mktemp "${TMPDIR:-/tmp}/aequitas-restore-verify.XXXXXX")"
printf 'DATABASE_URL=%s\nHASH_CHAIN_GENESIS=%s\nSTORAGE_LOCAL_DIR=/data/evidence\nRETENTION_ENFORCEMENT_ENABLED=true\nRETENTION_LEDGER_PATH=/retention/ledger.json\n' "$database_url" "$genesis" > "$verify_env"
unset database_url genesis
trap 'rm -f -- "$verify_env"' EXIT
# Obtain the authenticated identity, not a guessed username or owner fallback.
if ! runtime_role="$(docker run --rm --network aeq-prod-net --env-file "$verify_env" \
  --entrypoint node "$app_image" --input-type=module -e '
import pg from "pg";
const client = new pg.Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:5000,query_timeout:15000});
try { await client.connect(); const result=await client.query("SELECT current_user AS role"); process.stdout.write(result.rows[0].role); }
catch { console.error("RESTORE_RUNTIME_IDENTITY_UNAVAILABLE"); process.exitCode=1; }
finally { await client.end(); }
')"; then
  refuse 'the actual runtime database identity could not be verified.'
fi
[[ "$runtime_role" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || refuse 'the actual runtime role is not a supported PostgreSQL identifier.'
docker exec -i aeq-prod-postgres psql -X -q -v ON_ERROR_STOP=1 -U aequitas -d aequitas \
  -v "runtime_role=$runtime_role" -v "purger_role=$purger_role" \
  < ../retention/validate-restore-roles.sql || refuse 'the existing runtime/purger role separation is invalid.'

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

printf '%s\n' 'Replacing the production database schema.'
docker exec -i aeq-prod-postgres psql -X -q -v ON_ERROR_STOP=1 -U aequitas -d aequitas -c 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;'
docker exec -i aeq-prod-postgres pg_restore -U aequitas -d aequitas --no-owner --no-privileges --exit-on-error < "$dump"
# pg_restore --no-owner --no-privileges deliberately discards these ACLs.
# Validate again in provision-purger.sql, then restore owner-specific defaults.
docker exec -i aeq-prod-postgres psql -X -q -v ON_ERROR_STOP=1 -U aequitas -d aequitas \
  -v "runtime_role=$runtime_role" -v "purger_role=$purger_role" < ../retention/provision-purger.sql
docker exec -i aeq-prod-postgres psql -X -q -v ON_ERROR_STOP=1 -U aequitas -d aequitas \
  -v "runtime_role=$runtime_role" < ../retention/grant-restored-runtime.sql
if [[ -n "$ev" ]]; then
  printf '%s\n' 'Replacing the production evidence directory.'
  docker run --rm -i -v aeq-prod-evidence:/data public.ecr.aws/docker/library/postgres:18 sh -c 'rm -rf /data/evidence && mkdir -p /data && tar -C /data -xf - && chown -R 1000:1000 /data' < "$ev"
fi

run_verifier() {
  docker run --rm --network aeq-prod-net --env-file "$verify_env" \
    --mount type=volume,source=aeq-prod-evidence,target=/data,readonly \
    --mount type=volume,source=aeq-prod-retention-ledger,target=/retention,readonly \
    --entrypoint "$1" "$app_image" "${@:2}"
}

printf '%s\n' '== migrate status (one-off verifier; production app remains stopped)'
run_verifier node node_modules/prisma/build/index.js migrate status
printf '%s\n' '== restored runtime role isolation'
run_verifier node deploy/ct920/verify-runtime-role.mjs
printf '%s\n' '== row counts'
docker exec -i aeq-prod-postgres psql -U aequitas -d aequitas -At -F' ' < row-counts.sql | sort
printf '%s\n' '== verify:events (one-off verifier; production app remains stopped)'
run_verifier node node_modules/tsx/dist/cli.mjs scripts/verify-events.ts
printf '%s\n' '== evidence hashes (read-only volume; production app remains stopped)'
run_verifier node node_modules/tsx/dist/cli.mjs scripts/verify-evidence-files.ts
printf '%s\n' '== independent deletion ledger (replay/quarantine is required before restart)'
run_verifier node node_modules/tsx/dist/cli.mjs scripts/retention-restore.ts verify
printf '%s\n' 'Restore verification complete. The production app and scheduler remain stopped.'
