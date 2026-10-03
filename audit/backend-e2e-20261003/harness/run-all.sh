#!/usr/bin/env bash
# Full ordered audit run against production-mode servers. Usage: AUDIT_SP=<scratch> run-all.sh
set -uo pipefail
: "${AUDIT_SP:?}"; . "$AUDIT_SP/env.sh"
H=/home/user/aequitas/audit/backend-e2e-20261003/harness
EV=/home/user/aequitas/audit/backend-e2e-20261003/evidence
cd /home/user/aequitas
rm -rf "$EV/results" "$EV/observations" "$EV/http"; mkdir -p "$EV/results"
: > "$SP/logs/outbound-denied.log"
"$H/reset-all.sh"
"$H/stack.sh" stub-start
suite() { # storage, name
  AUDIT_RESULTS_JSON="$EV/results/$2.json" "$H/run-suite.sh" "$1" "test/audit/$3.audit.ts" > "$SP/logs/final-$2.log" 2>&1
  node -e 'const r=require(process.argv[1]);console.log(process.argv[2].padEnd(34),"passed",String(r.numPassedTests).padStart(4),"failed",String(r.numFailedTests).padStart(3))' "$EV/results/$2.json" "$2"
}
"$H/stack.sh" server-start s3 on
suite s3 00-harness-smoke 00-harness-smoke
suite s3 01-http-production 01-http-production
suite s3 02-authentication 02-authentication
suite s3 03-invitations-email 03-invitations-email
suite s3 04-case-workflows 04-case-workflows
suite s3 05-authorization 05-authorization
suite s3 06-evidence-storage-s3 06-evidence-storage-export
suite s3 07-ai-and-concurrency 07-ai-and-concurrency
suite s3 10-input-robustness 10-input-robustness
suite s3 08-integrity 08-integrity
"$H/stack.sh" server-start local on
suite local 06-evidence-storage-local 06-evidence-storage-export
"$H/stack.sh" server-start s3 off
suite s3 11-mail-not-configured 11-mail-not-configured
"$H/stack.sh" server-start s3 on
echo "--- outbound deny log (must be empty) ---"; wc -c < "$SP/logs/outbound-denied.log"
echo done
