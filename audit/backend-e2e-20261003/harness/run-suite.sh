#!/usr/bin/env bash
# Usage: run-suite.sh <s3|local> <test-file-glob-or-names...>
# Runs black-box audit suites against the ALREADY RUNNING production-mode server (see stack.sh).
# The database target is verified by with-db.sh before vitest starts.
set -euo pipefail
: "${AUDIT_SP:?AUDIT_SP must point at the scratch directory}"
. "$AUDIT_SP/env.sh"
STORAGE="${1:?s3|local}"; shift
set -a; . "$SP/stack.env"; set +a
export AUDIT_SESSION_SECRET="$SESSION_SECRET" AUDIT_STORAGE="$STORAGE" AUDIT_LOCAL_DIR="$SP/storage-local"
export AUDIT_S3_ENDPOINT="$STORAGE_ENDPOINT" AUDIT_S3_BUCKET="$STORAGE_BUCKET" AUDIT_S3_REGION="$STORAGE_REGION" AUDIT_S3_ACCESS_KEY="$STORAGE_ACCESS_KEY" AUDIT_S3_SECRET_KEY="$STORAGE_SECRET_KEY"
export AUDIT_BASE_URL="http://127.0.0.1:${AUDIT_PORT:-3457}" AUDIT_STUB_URL="http://127.0.0.1:${AUDIT_STUB_PORT:-4581}"
export AUDIT_WEBAUTHN_ORIGIN="https://aequitas-audit.invalid" AUDIT_WEBAUTHN_RP_ID="aequitas-audit.invalid"
export AUDIT_IP_HASH_SALT="$IP_HASH_SALT"
export AUDIT_DENY_LOG="$SP/logs/outbound-denied.log"
export AUDIT_TAMPER_DATABASE_URL="postgresql://aq_test:$(cat "$SP/pgtestpass.txt")@127.0.0.1:54329/aequitas_audit_tamper_test" AUDIT_WITH_DB="/home/user/aequitas/audit/backend-e2e-20261003/harness/with-db.sh"
export DOCKER_HOST="unix:///run/aqd/d.sock" AUDIT_INFRA="/home/user/aequitas/audit/backend-e2e-20261003/harness/infra.sh"
export AUDIT_EVIDENCE_DIR="/home/user/aequitas/audit/backend-e2e-20261003/evidence"
cd /home/user/aequitas
exec audit/backend-e2e-20261003/harness/with-db.sh aequitas_audit_test -- bash -c 'export AUDIT_DATABASE_URL="$DATABASE_URL"; unset DATABASE_URL; exec npx vitest run --config vitest.audit.config.mts "$@"' _ "$@"
