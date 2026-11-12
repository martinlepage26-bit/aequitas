#!/usr/bin/env bash
# Restore a trusted backup into fresh, temporary Docker resources. This script
# never reads the production environment or uses the production Compose stack.
set -euo pipefail

usage() {
  printf 'Usage: %s --app-image <local-image> <dump> <evidence.tar>\n' "$0" >&2
}
refuse() { printf 'Isolated restore refused: %s\n' "$1" >&2; exit 1; }
if [[ "$#" -ne 4 || "${1:-}" != --app-image ]]; then usage; exit 64; fi
app_ref="$2"
[[ -n "$app_ref" && "$app_ref" != -* ]] || refuse 'a local app image is required.'
[[ -f "$3" && -r "$3" && -f "$4" && -r "$4" ]] || refuse 'both backup files must be readable regular files.'
dump="$3"
evidence="$4"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
[[ -f "$script_dir/row-counts.sql" ]] || refuse 'row-counts.sql is missing.'
genesis="${HASH_CHAIN_GENESIS:-$(printf '%064d' 0)}"
[[ "$genesis" =~ ^[a-fA-F0-9]{64}$ ]] || refuse 'HASH_CHAIN_GENESIS must contain exactly 64 hexadecimal characters.'

# Resolve local images once. No pull, build, production container inspection,
# arbitrary target-name option, or inherited Docker/Compose environment file.
app_image="$(docker image inspect --format '{{.Id}}' "$app_ref")" || refuse 'the app image is not available locally.'
pg_image="$(docker image inspect --format '{{.Id}}' public.ecr.aws/docker/library/postgres:18)" || refuse 'the PostgreSQL 18 image is not available locally.'
[[ "$app_image" =~ ^sha256:[a-f0-9]{64}$ && "$pg_image" =~ ^sha256:[a-f0-9]{64}$ ]] || refuse 'local images did not resolve to immutable image IDs.'

umask 077
work="$(mktemp -d "${TMPDIR:-/tmp}/aequitas-restore-drill.XXXXXXXX")"
run_id="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
[[ "$run_id" =~ ^[a-f0-9]{32}$ ]] || { rm -rf -- "$work"; refuse 'could not generate a unique resource ID.'; }
prefix="aeq-restore-drill-$run_id"
label="com.aequitas.restore-drill=$run_id"
network="$prefix-net"
database="$prefix-db"
pg_volume="$prefix-pgdata"
evidence_volume="$prefix-evidence"

cleanup() {
  local status=$? failed=0 kind resources resource
  trap - EXIT INT TERM
  # The random ownership label also covers resources created immediately before
  # an interruption. Never remove resources merely because their name matches.
  for kind in container volume network; do
    if [[ "$kind" == container ]]; then
      resources="$(docker container ls -aq --filter "label=$label")" || { failed=1; continue; }
    else
      resources="$(docker "$kind" ls -q --filter "label=$label")" || { failed=1; continue; }
    fi
    while IFS= read -r resource; do
      [[ -n "$resource" ]] || continue
      if [[ "$kind" == container ]]; then
        docker container rm -f "$resource" >/dev/null || failed=1
      else
        docker "$kind" rm "$resource" >/dev/null || failed=1
      fi
    done <<< "$resources"
  done
  rm -rf -- "$work"
  if [[ "$failed" -ne 0 ]]; then
    printf 'Cleanup incomplete for ownership label %s; inspect those resources before closing the drill.\n' "$label" >&2
    status=1
  else
    printf 'Removed all resources owned by %s.\n' "$prefix"
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Refuse collisions before creating anything; volume create alone can reuse an
# existing volume. Verify the ownership label again before mounting any volume.
for volume in "$pg_volume" "$evidence_volume"; do
  if docker volume inspect "$volume" >/dev/null 2>&1; then refuse 'a generated volume name already exists.'; fi
done
if docker network inspect "$network" >/dev/null 2>&1 || docker container inspect "$database" >/dev/null 2>&1; then
  refuse 'a generated resource name already exists.'
fi

printf 'Isolated restore resource group: %s\n' "$prefix"
printf 'App image: %s\nPostgreSQL image: %s\n' "$app_image" "$pg_image"
# Validate archives in networkless containers before creating the restore DB.
docker run --rm -i --label "$label" --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --entrypoint pg_restore "$pg_image" --list \
  < "$dump" > "$work/dump-check.log" 2>&1 || refuse 'the database dump is not a readable PostgreSQL archive.'
docker run --rm -i --label "$label" --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --entrypoint tar "$pg_image" -tf - \
  < "$evidence" > "$work/evidence-check.log" 2>&1 || refuse 'the evidence archive is unreadable.'

docker network create --internal --label "$label" "$network" >/dev/null
for volume in "$pg_volume" "$evidence_volume"; do
  docker volume create --label "$label" "$volume" >/dev/null
  owner="$(docker volume inspect --format '{{index .Labels "com.aequitas.restore-drill"}}' "$volume")"
  [[ "$owner" == "$run_id" ]] || refuse 'a generated volume is not owned by this drill.'
done
password="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
[[ "$password" =~ ^[a-f0-9]{64}$ ]] || refuse 'could not generate a temporary database password.'
printf 'POSTGRES_USER=aequitas\nPOSTGRES_DB=aequitas\nPOSTGRES_PASSWORD=%s\n' "$password" > "$work/postgres.env"
printf 'DATABASE_URL=postgresql://aequitas:%s@%s:5432/aequitas\nSTORAGE_LOCAL_DIR=/data/evidence\nHASH_CHAIN_GENESIS=%s\nPGOPTIONS=-c default_transaction_read_only=on\n' \
  "$password" "$database" "$genesis" > "$work/verifier.env"
unset password
docker run -d --name "$database" --label "$label" --network "$network" \
  --env-file "$work/postgres.env" --mount "type=volume,source=$pg_volume,target=/var/lib/postgresql" \
  "$pg_image" > /dev/null
ready=0
for ((attempt=0; attempt<60; attempt++)); do
  if docker exec "$database" pg_isready -h 127.0.0.1 -U aequitas -d aequitas >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[[ "$ready" == 1 ]] || refuse 'the isolated PostgreSQL server did not become ready.'
docker exec -i "$database" pg_restore -U aequitas -d aequitas --no-owner --no-privileges --exit-on-error \
  < "$dump" > "$work/restore.log" 2>&1 || refuse 'restoring the isolated database failed (backup content omitted).'
# Only the fresh evidence volume is writable. The image root is read-only;
# no host directory or Docker socket is mounted and networking is disabled.
docker run --rm -i --label "$label" --network none --read-only --security-opt no-new-privileges:true \
  --mount "type=volume,source=$evidence_volume,target=/data" --entrypoint sh "$pg_image" \
  -c 'tar --no-same-owner -C /data -xf - && chown -R 1000:1000 /data' \
  < "$evidence" > "$work/evidence-restore.log" 2>&1 || refuse 'restoring isolated evidence failed (backup content omitted).'

run_verifier() {
  local check="$1"
  shift
  if ! docker run --rm --label "$label" --network "$network" --read-only --cap-drop ALL \
    --security-opt no-new-privileges:true --user 1000:1000 --tmpfs /tmp:rw,noexec,nosuid,nodev,mode=1777 \
    --env-file "$work/verifier.env" --mount "type=volume,source=$evidence_volume,target=/data,readonly" \
    --entrypoint node "$app_image" "$@" > "$work/verifier.log" 2>&1; then
    refuse "$check failed in the isolated restore (record details are not printed)."
  fi
  printf '%s: passed\n' "$check"
}
run_verifier 'Migration status' node_modules/prisma/build/index.js migrate status
printf '%s\n' 'Restored table row counts (compare with a baseline captured with this backup, if available):'
docker exec -i "$database" psql -X -v ON_ERROR_STOP=1 -U aequitas -d aequitas -At -F ' ' \
  < "$script_dir/row-counts.sql" | sort
run_verifier 'Event chains and projections' node_modules/tsx/dist/cli.mjs scripts/verify-events.ts
run_verifier 'Evidence file hashes and sizes' node_modules/tsx/dist/cli.mjs scripts/verify-evidence-files.ts
printf '%s\n' 'Isolated restore verification passed; removing disposable resources.'
