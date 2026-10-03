#!/usr/bin/env bash
# Resets ONLY the disposable audit state: the aequitas_audit_test and aequitas_audit_tamper_test databases on the audit
# cluster, the audit MinIO bucket data, and the local-storage directory. Every target is verified before it is touched.
set -euo pipefail
: "${AUDIT_SP:?}"; . "$AUDIT_SP/env.sh"
H=/home/user/aequitas/audit/backend-e2e-20261003/harness
"$H/stack.sh" server-stop
export PGPASSWORD="$(cat "$SP/pgpass.txt")"
psqlx() { psql -h 127.0.0.1 -p 54329 -U aq_admin -d postgres -At "$@"; }
[ "$(psqlx -c 'show data_directory')" = "/var/lib/aq-pg-audit/data" ] || { echo "REFUSED: not the audit cluster" >&2; exit 91; }
for DB in aequitas_audit_test aequitas_audit_tamper_test; do
  case "$DB" in aequitas_audit_test|aequitas_audit_tamper_test) ;; *) exit 92 ;; esac
  psqlx -c "select pg_terminate_backend(pid) from pg_stat_activity where datname='$DB' and pid <> pg_backend_pid()" >/dev/null
  psqlx -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB OWNER aq_test" >/dev/null
  ( cd /home/user/aequitas && "$H/with-db.sh" "$DB" -- npx prisma migrate deploy 2>&1 | grep -E "applied|No pending" | head -2 && "$H/with-db.sh" "$DB" -- npx tsx prisma/seed.ts 2>&1 | tail -1 )
done
# object storage: only paths under the scratch directory are ever removed
"$H/infra.sh" minio-stop || true
case "$SP/minio-data" in "$SP"/*) rm -rf "$SP/minio-data" && mkdir -p "$SP/minio-data" ;; esac
case "$SP/storage-local" in "$SP"/*) rm -rf "$SP/storage-local" && mkdir -p "$SP/storage-local" ;; esac
"$H/infra.sh" minio-start
set -a; . "$SP/stack.env"; set +a
( cd /home/user/aequitas && DATABASE_URL="postgresql://placeholder@127.0.0.1:54329/aequitas_audit_test" npm run ensure:storage-bucket 2>&1 | tail -1 )
echo "reset complete"
