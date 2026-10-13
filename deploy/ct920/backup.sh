#!/usr/bin/env bash
# Nightly app-consistent backup: pg_dump -Fc + evidence tar.
# Retention: 14 daily, 8 weekly (Sunday copies). Target: $BACKUP_ROOT on CT920.
# Off-box copy (penguin-backups NFS or Martin's Mac over NetBird) is PENDING.
set -euo pipefail
BACKUP_ROOT="${BACKUP_ROOT:-$HOME/aequitas-prod/backups}"
ts="$(date +%Y%m%d-%H%M)"; umask 077
mkdir -p "$BACKUP_ROOT/daily" "$BACKUP_ROOT/weekly"
d="$BACKUP_ROOT/daily/$ts"; mkdir -p "$d"
docker exec aeq-prod-postgres pg_dump -U aequitas -d aequitas -Fc > "$d/aequitas.dump"
docker run --rm -v aeq-prod-evidence:/data:ro public.ecr.aws/docker/library/postgres:18 tar -C /data -cf - . > "$d/evidence.tar"
(cd "$d" && sha256sum aequitas.dump evidence.tar > SHA256SUMS)
[ "$(date +%u)" = 7 ] && cp -a "$d" "$BACKUP_ROOT/weekly/$ts"
ls -1dt "$BACKUP_ROOT"/daily/*/  | tail -n +15 | xargs -r rm -rf
ls -1dt "$BACKUP_ROOT"/weekly/*/ | tail -n +9  | xargs -r rm -rf
echo "backup ok: $d"
