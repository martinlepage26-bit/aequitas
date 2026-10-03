#!/usr/bin/env bash
# Usage: with-db.sh <dbname> -- <command...>
# Refuses to run <command> unless <dbname> is one of the three disposable audit databases on the
# disposable audit Postgres cluster (127.0.0.1:54329, data dir /var/lib/aq-pg-audit/data).
# Exports DATABASE_URL for the command. Credentials come from files outside the repo; never printed.
set -euo pipefail
. "${AUDIT_SP:?AUDIT_SP (scratch dir) must be set}/env.sh"
DB="${1:?db name}"; shift; [ "${1:-}" = "--" ] && shift
case "$DB" in aequitas_audit_test|aequitas_audit_suite_test|aequitas_audit_tamper_test) ;; *) echo "REFUSED: '$DB' is not an allowed audit database" >&2; exit 90;; esac
ADMINPW="$(cat "$SP/pgpass.txt")"; TESTPW="$(cat "$SP/pgtestpass.txt")"
chk() { PGPASSWORD="$ADMINPW" psql -h 127.0.0.1 -p 54329 -U aq_admin -d "$DB" -At -c "$1"; }
[ "$(chk "select current_database()")" = "$DB" ] || { echo "REFUSED: current_database mismatch" >&2; exit 91; }
[ "$(chk "select inet_server_port()")" = "54329" ] || { echo "REFUSED: port mismatch" >&2; exit 92; }
[ "$(chk "show data_directory")" = "/var/lib/aq-pg-audit/data" ] || { echo "REFUSED: data_directory mismatch" >&2; exit 93; }
echo "[db-guard] target verified: db=$DB host=127.0.0.1 port=54329 datadir=/var/lib/aq-pg-audit/data" >&2
export DATABASE_URL="postgresql://aq_test:${TESTPW}@127.0.0.1:54329/${DB}"
exec "$@"
