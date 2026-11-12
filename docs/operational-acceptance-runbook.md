# Operational acceptance runbook (aeq-prod on CT920)

**Status:** unexecuted operational procedure, corrected against the checked-out candidate after PR #14 head `bb2b60d`. It has not yet been executed against a deployed release. Running it does not by itself close the operational-acceptance gate in [paid-pilot readiness](paid-pilot-readiness.md); the recorded results do.

## Purpose and boundary

This runbook gives the deployment operator one reproducible pass that covers the checks the readiness gates name: release and health, parser containment, scheduled operations, email, passkeys, routes, backup and restore, and retention. Every step states the command, the expected result, and the evidence to record.

- Run it on CT920 in the operator shell, in the checked-out release directory, after `deploy/ct920/deploy.sh` has completed for an approved release. Steps marked **client** are run from an ordinary workstation and are recorded separately; a client observation never substitutes for a CT920 observation and must not be described as server state.
- It is read-mostly. Production writes are limited to the explicitly authorized synthetic invitation, account, recovery and case actions below. The restore drill writes only to fresh disposable Docker resources. It never invokes the production-only `verify-restore.sh`.
- It assumes the stack in `deploy/ct920/compose.yaml` (`aeq-prod-app`, `aeq-prod-evidence-parser`, `aeq-prod-postgres`, `aeq-prod-clamav`, and `aeq-prod-scheduler` under the `scheduled` profile).

Record `RELEASE_SHA`, the UTC start time, the scheduler start time from the deployment receipt, the operator identity, and the host at the top of the acceptance record, then one line per check with pass, fail, or not applicable and the evidence named below. Merge, deployment, real case data, and live model use remain separately authorized; a green run here does not grant them.

## 0. Preconditions

Use Bash from the repository root on CT920. Define the helpers in this shell; the explicit Compose file and environment file are required when running from that directory. These commands do not print secrets or start services. Never use `docker compose config` or dump container environment values into the acceptance record.

```bash
export RELEASE_SHA="$(git rev-parse HEAD)"
ACCEPTANCE_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
# Set this to the scheduler start timestamp from the approved deployment receipt.
SCHEDULER_READY_SINCE='<deployment scheduler start, ISO 8601 UTC>'
compose() {
  docker compose --env-file deploy/ct920/.env -f deploy/ct920/compose.yaml -p aeq-prod "$@"
}
sql() {
  docker exec -i aeq-prod-postgres psql -X -v ON_ERROR_STOP=1 -U aequitas -d aequitas "$@"
}
```

| Check | Command | Expected |
| --- | --- | --- |
| Release identity | `git rev-parse HEAD` | Equals the approved release SHA recorded in the hosted task. |
| Secrets file | `stat -c %a deploy/ct920/.env` | `600`. Do not print the file. |
| Compose project | `compose ps` | `app`, `evidence-parser`, `postgres`, `clamav` are `running (healthy)`. |
| Scheduler | `compose --profile scheduled ps scheduler` | `running (healthy)` after its 180 s start period. |

Evidence: the four command outputs, with secrets absent.

## 1. Release and health

| Check | Command | Expected |
| --- | --- | --- |
| Health reports the release | `curl -fsS http://127.0.0.1:18310/api/health` | `{"status":"ok","release":"<RELEASE_SHA>"}` |
| Images match the release | `docker inspect --format '{{.Image}}' aeq-prod-app aeq-prod-evidence-parser aeq-prod-scheduler` | Three image IDs; `app` and `scheduler` share one. Compare them with `docker image inspect --format '{{.Id}}' "aeq-prod-app:$RELEASE_SHA" "aeq-prod-evidence-parser:$RELEASE_SHA"`; record all IDs. Matching only a label does not establish the running release. |
| Image labels | `docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.base.name"}}' aeq-prod-app:$RELEASE_SHA aeq-prod-evidence-parser:$RELEASE_SHA` | The pinned base images from the two Dockerfiles. |
| Database migrated | `compose exec -T app node node_modules/prisma/build/index.js migrate status` | No pending migrations. |

Evidence: outputs, plus the image IDs copied into the record. The image IDs are what any security disposition must be tied to.

## 2. Evidence parser containment

The parser must be networkless, read-only, non-root, resource-limited and secret-free, reachable only through the Unix socket volume.

| Check | Command | Expected |
| --- | --- | --- |
| Network | `docker inspect --format '{{.HostConfig.NetworkMode}}' aeq-prod-evidence-parser` | `none` |
| Filesystem and privileges | `docker inspect --format '{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.CapDrop}} {{.HostConfig.SecurityOpt}} {{.Config.User}}' aeq-prod-evidence-parser` | `true [ALL] [no-new-privileges:true] 10001:2000` |
| Limits | `docker inspect --format '{{.HostConfig.PidsLimit}} {{.HostConfig.Memory}} {{.HostConfig.NanoCpus}}' aeq-prod-evidence-parser` | `32 1073741824 1000000000` |
| Environment is secret-free | `docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' aeq-prod-evidence-parser \| cut -d= -f1 \| sort` | Only the names `AEQUITAS_EVIDENCE_PARSER_SOCKET`, `AEQUITAS_OCR_LANGUAGES`, `HOME`, `TMPDIR`, `NODE_ENV`, `PATH`. No database, storage, email or provider variables. Review the Compose definition to confirm the parser has no application `env_file`; never print values. |
| Socket ownership | `docker exec aeq-prod-evidence-parser stat -c '%u:%g %a %F' /run/aeq-parser /run/aeq-parser/evidence.sock` | Directory `10001:2000 730 directory`; socket `10001:2000 660 socket`. |
| Unused and vulnerable tools absent | `docker exec aeq-prod-evidence-parser sh -c 'for b in tiff2pdf tiffcrop dirmngr gpg-agent gpgsm pinentry; do command -v "$b" && exit 1; done; echo absent'` | `absent` |
| Package versions for the security record | `docker exec aeq-prod-evidence-parser dpkg-query -W 'libtiff6' 'libpoppler*' 'libleptonica*' 'tesseract-ocr' 'libxml2*'` | Versions recorded verbatim; compare with the latest [vulnerability review](candidate-container-vulnerability-review.md). |
| Extraction path works | After sections 4–6 establish the test account and synthetic case, upload a one-page generated PDF with selectable text and inspect its extraction record as authorized staff. | Extraction status `extracted`, method `pdftotext`. The parser has no per-request access logging; its logs cannot prove a request count. |
| TIFF is handed to staff | Upload a small synthetic TIFF to the same case. | Evidence stored with extraction `unsupported` and no extracted text; staff review is required. The deployed parser has no per-request counter, so absence of log lines is not evidence that no request occurred. The focused TIFF regression test provides that routing assertion. |

Evidence: outputs, the two synthetic evidence record IDs and extraction statuses. Inspect `docker logs --since "$ACCEPTANCE_STARTED_AT" aeq-prod-evidence-parser` for failures; retain only redacted excerpts, with no tokens, addresses or case content.

## 3. Scheduled operations

| Check | Command | Expected |
| --- | --- | --- |
| Operations completed on this release | `compose --profile scheduled exec -T -e "SCHEDULER_READY_SINCE=$SCHEDULER_READY_SINCE" scheduler node node_modules/tsx/dist/cli.mjs scripts/verify-scheduled-ops.ts` | `All scheduled operations completed successfully on this release.` |
| Heartbeats | `docker exec aeq-prod-postgres psql -U aequitas -d aequitas -c 'select name, "lastOutcome", "lastSuccessfulAt" from "ScheduledOperationHeartbeat" order by name'` | `notification_retry` and `case_agent` have `SUCCEEDED` on this release. Their intervals are 15 and 10 minutes; health becomes overdue after twice that interval. A disabled case agent still records a successful no-op run; disabled is not a heartbeat outcome. |
| Case agent stays off unless fully configured | `docker exec aeq-prod-scheduler sh -c 'echo ${AEQUITAS_CASE_AGENT_ENABLED:-false}'` | `false` for this acceptance unless the hosted task records an explicit program and evaluation approval. |
| Operations page | **client:** open `/fr-CA/admin/operations` as an admin. | Both operations listed with the same timestamps as the database rows. |

Evidence: outputs and a note of the admin identity used.

## 4. Email

These actions send mail only to the operator-controlled test mailbox named in the hosted acceptance task. Do not create deliberately invalid recipients on production or change provider settings to force failures. Retry failures belong in automated tests or an isolated nonproduction test environment.

| Check | Command | Expected |
| --- | --- | --- |
| Provider configuration | `compose exec -T scheduler node node_modules/tsx/dist/cli.mjs -e 'import { emailConfigured } from "./src/lib/mail"; const ok = emailConfigured(); console.log(ok ? "configured" : "not configured"); process.exit(ok ? 0 : 1)'` | `configured`. This checks the sender, reply-to, HTTPS app URL and encryption-key length as well as the provider key, without printing values. |
| Invitation delivery | As an admin, issue an invitation to the operator-controlled mailbox from `/fr-CA/admin/invites`. Record its invitation ID from the authorized response without copying its token. | The message arrives from the configured sender; the link opens `/fr-CA/invite/<token>`. The request attempts delivery immediately; transient failures may wait for the 15-minute retry interval. A provider acceptance timestamp alone does not prove inbox receipt. |

Set `INVITATION_ID` to that synthetic invitation's ID and run this query. Invitations use `Invitation.emailedAt` and `deliveryAttempts`, not the case-notification table.

```bash
sql -v invitation_id="$INVITATION_ID" <<'SQL'
SELECT id, "emailedAt", "deliveryAttempts",
       "deliveryPayloadCiphertext" IS NOT NULL AS ciphertext,
       "deliveryPayloadNonce" IS NOT NULL AS nonce,
       "deliveryPayloadTag" IS NOT NULL AS tag
FROM "Invitation" WHERE id = :'invitation_id';
SQL
```

Expected after provider acceptance: `emailedAt` is set, attempts is at least 1 (at most the bound of 8), and all three encrypted-payload columns are cleared (`f`). While a retryable delivery is pending, all three are populated (`t`). A successful delivery cannot also demonstrate a pending ciphertext in the same row. Never select token hashes, payload bytes or recipient addresses into the receipt. The schema contains a hashed token; the associated user still has an email address, so this check does not imply all account data is encrypted.

Evidence: the synthetic invitation ID, the query output, mailbox receipt time, and sender/domain verification without message bodies or token-bearing links. Capture only redacted scheduler diagnostics if a retry occurs. Automated retry tests cover rejection, uncertain delivery and the bounded retry policy.

## 5. Passkeys and account recovery

| Check | Command | Expected |
| --- | --- | --- |
| Relying party matches the production hostname | `docker exec aeq-prod-app sh -c 'printf "%s\n" "$WEBAUTHN_RP_ID" "$WEBAUTHN_ORIGIN" "$APP_URL"'` | The public hostname and `https://` origin that users actually visit. |
| Enrolment | **client:** claim the invitation from section 4 on the production hostname and register a passkey. | Registration completes; the user row and credential row exist. |
| Sign-in | **client:** sign out, then sign in with that passkey at `/fr-CA/auth/sign-in`. | A session is established; `/fr-CA/cases` loads. |
| Recovery | **client:** request recovery at `/fr-CA/auth/recover`, follow the emailed link, and enrol a replacement passkey. | The previous credential rows are removed, existing sessions are invalidated, and the replacement passkey signs in. Perform this only for the synthetic account. |
| Existing users | Before any separately authorized re-enrolment of an existing user, confirm that identity out of band. | Recorded per user; not part of a synthetic run. |

Evidence: test user ID, credential row IDs before and after recovery, and timestamped sign-in/recovery outcomes. The current sign-in implementation does not emit a case `Event`, so do not require a sign-in event ID. Delete nothing; mark the test account for cleanup under the retention decision.

## 6. Routes and locales

Run `curl -sS -o /dev/null -w '%{http_code}\n' "${ORIGIN}${ROUTE}"` for each route below, setting `ORIGIN=http://127.0.0.1:18310` on CT920 and, separately marked **client**, the public HTTPS origin. Do not follow redirects when checking the status. For redirect checks, inspect the `Location` header with `curl -sS -o /dev/null -D - "${ORIGIN}${ROUTE}"`; redact any cookies before storing output. The root locale can follow a browser language preference, so use an unauthenticated curl request with no language cookie for the default-locale check.

| Route | Expected |
| --- | --- |
| `/` | redirect to `/fr-CA` (next-intl routing) |
| `/fr-CA`, `/en-CA` | `200` |
| `/fr-CA/demo`, `/en-CA/demo` | `200` for this candidate, which includes the fictional case demo. Verify the release SHA rather than carrying forward an old production observation. |
| `/fr-CA/auth/sign-in` | `200` |
| `/fr-CA/cases` without a session | redirect to sign-in |
| `/api/health` | `200` with the release SHA |
| `/api/cases` without a session | `401` with `Not authenticated.` |

Then, as the test user, create one case at `/fr-CA/cases/new` with clearly synthetic party names, use it for sections 2 and 7, and use its authorized Withdraw/Close action when done. Do not mutate database state directly or start model processing for this acceptance. Record its case ID.

Evidence: status codes for both origins, kept in separate columns, and the case ID.

## 7. Evidence integrity

| Check | Command | Expected |
| --- | --- | --- |
| Event hash chain | `compose exec -T app node node_modules/tsx/dist/cli.mjs scripts/verify-events.ts` | Chain verifies from `HASH_CHAIN_GENESIS` with no breaks. |
| Stored evidence files | `compose exec -T app node node_modules/tsx/dist/cli.mjs scripts/verify-evidence-files.ts` | Every evidence record has its file and matching digest. |
| New events carry no case content | Run the scoped query below for the synthetic case only. | `CASE_CREATED` payload is empty; chronology events hold only row IDs. |
| ClamAV | `docker exec aeq-prod-clamav clamdcheck.sh` and `docker exec aeq-prod-clamav clamscan --version` | Daemon healthy; record the engine version and signature build timestamp reported by ClamAV. A file mtime alone does not establish signature freshness; compare the reported signature date with the accepted update policy. |

Set `CASE_ID` to the synthetic case ID. Never substitute a real case merely to obtain an example payload.

```bash
sql -v case_id="$CASE_ID" <<'SQL'
SELECT type, payload FROM "Event" WHERE "caseId" = :'case_id' ORDER BY seq;
SQL
```

Evidence: verifier exit statuses and summaries, the synthetic-case query, and ClamAV output. Full verifier failures may contain existing case references or storage keys; inspect locally and redact before publication.

## 8. Backup and restore

Set `BACKUP_ROOT` to the configured backup location (default `$HOME/aequitas-prod/backups`) and `BACKUP_DIR` to the specific approved backup directory under `daily`. Quote both paths. Inspect the existing nightly job receipt; do not run `backup-offbox.sh` as a read-only check: it creates a backup, copies it off-box and applies backup retention.

```bash
BACKUP_ROOT="${BACKUP_ROOT:-$HOME/aequitas-prod/backups}"
ls -ld "$BACKUP_ROOT"/daily/*/
# Choose the actual directory, not the literal placeholder.
BACKUP_DIR="$BACKUP_ROOT/daily/<backup timestamp>"
(cd "$BACKUP_DIR" && sha256sum -c SHA256SUMS)
```

Expected: a completed backup from the last 24 hours containing `aequitas.dump`, `evidence.tar` and `SHA256SUMS`, with `OK` for both archives. An off-box success receipt must include destination checksum verification from the existing job, not merely a local directory listing. The backup script does not quiesce application writers across the dump and evidence tar, so a matching checksum is not proof of cross-store consistency; the restore verification below tests the actual pair.

The dedicated drill creates unique labelled Docker containers, volumes and an internal network; it publishes no ports, inherits no application secrets, starts no app or scheduler, and removes its resources and temporary credentials on success or failure. It requires the approved app image and PostgreSQL 18 image to be available locally; it does not pull images. It restores sensitive backup data only inside this disposable group on the authorized host. Do not use it on a personal workstation with real case backups unless that separate data movement is authorized.

```bash
APP_IMAGE_ID="$(docker inspect --format '{{.Image}}' aeq-prod-app)"
# Read only the non-secret genesis hash; never copy or source the app environment.
HASH_CHAIN_GENESIS="$(docker exec aeq-prod-app node -e 'process.stdout.write(process.env.HASH_CHAIN_GENESIS ?? "0".repeat(64))')"
export HASH_CHAIN_GENESIS
bash deploy/ct920/verify-restore-isolated.sh --app-image "$APP_IMAGE_ID" \
  "$BACKUP_DIR/aequitas.dump" "$BACKUP_DIR/evidence.tar"
```

Expected: exit 0, migration status passed, event chains and projections passed, evidence file hashes and sizes passed, and confirmed cleanup. The command reports restored table counts; compare with counts captured at backup time if such a baseline exists. `row-counts.sql` is a query, not an expected-count fixture, and the current backup script does not capture a baseline. Pending migrations cause the drill to fail; select a backup compatible with the release under test or separately authorize a disposable migration rehearsal.

Record the generated `aeq-restore-drill-…` group and image IDs. If cleanup fails, the command exits nonzero and prints its ownership label: inspect only resources with that exact label and resolve their removal before closing the drill. Forced process termination or host loss can prevent traps from running, so verify no labelled resources remain after an interrupted run. Do not publish raw archive contents or database credentials.

**Never invoke `verify-restore.sh` for this drill.** That separate disaster-recovery command is hardcoded to production resource names, requires `--confirm-production-replacement` plus typed confirmation, and replaces live data. Changing directories or supplying a different Compose project does not redirect it.

Evidence: backup and off-box receipts, checksum output, isolated drill exit status and output, comparison baseline if available, and cleanup result. No operational restore pass is claimed until this executes on the authorized host with the actual backup pair.

## 9. Retention and deletion

The candidate implements the reviewed lifecycle in [retention and deletion](retention-deletion-design.md). Before enabling it on the target host, verify the separate runtime/purger roles, current independent ledger and replication, writer drain, local/S3 ownership and external-copy inventory. Run the synthetic request → hold review → approval → freeze → inventory → object erasure → database purge sequence, prove a hold and a failed store block progress, and verify every retained receipt contains only allowed metadata. Restore a pre-erasure backup in isolated resources with the current independent ledger; startup must refuse until replay quarantines restored records. Also restore an older object archive beside a post-purge database: verification must refuse until separately reviewed residual-object reconciliation. Keep real records out of this test and leave model processing disabled unless its own activation gates are satisfied.

Evidence: the case ID and test user ID from sections 5 and 6, flagged for cleanup.

## 10. Closing the record

1. Fill the one-line-per-check table with pass, fail or not applicable and the evidence pointers.
2. Write a hosted task checkpoint that names the release SHA, the image IDs from section 1, the parser package versions from section 2, and any failed or skipped step. Keep client observations in their own lines.
3. Any failed or unexecuted required check leaves operational acceptance open. Record any proposed exception with its owner and retest date; do not treat it as an automatic substitute for the readiness gates or a successful restore.
4. The record does not approve merge, deployment, real case data or live model use. Those stay with their named approvers in [paid-pilot readiness](paid-pilot-readiness.md).
