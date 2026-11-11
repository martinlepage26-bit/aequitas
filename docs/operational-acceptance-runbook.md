# Operational acceptance runbook (aeq-prod on CT920)

**Status:** draft procedure, written 2026-11-11 against PR #14 head `46675b6`. It has not yet been executed against a deployed release. Running it does not by itself close the operational-acceptance gate in [paid-pilot readiness](paid-pilot-readiness.md); the recorded results do.

## Purpose and boundary

This runbook gives the deployment operator one reproducible pass that covers the checks the readiness gates name: release and health, parser containment, scheduled operations, email, passkeys, routes, backup and restore, and retention. Every step states the command, the expected result, and the evidence to record.

- Run it on CT920 in the operator shell, in the checked-out release directory, after `deploy/ct920/deploy.sh` has completed for an approved release. Steps marked **client** are run from an ordinary workstation and are recorded separately; a client observation never substitutes for a CT920 observation and must not be described as server state.
- It is read-mostly. The only writes are the synthetic test records it tells you to create and then close. It never runs `verify-restore.sh` against production.
- It assumes the stack in `deploy/ct920/compose.yaml` (`aeq-prod-app`, `aeq-prod-evidence-parser`, `aeq-prod-postgres`, `aeq-prod-clamav`, and `aeq-prod-scheduler` under the `scheduled` profile).

Record `RELEASE_SHA`, the UTC start time, the operator identity, and the host at the top of the acceptance record, then one line per check with pass, fail, or not applicable and the evidence named below. Merge, deployment, real case data, and live model use remain separately authorized; a green run here does not grant them.

## 0. Preconditions

| Check | Command | Expected |
| --- | --- | --- |
| Release identity | `git -C <checkout> rev-parse HEAD` | Equals the approved release SHA recorded in the hosted task. |
| Secrets file | `stat -c %a deploy/ct920/.env` | `600`. Do not print the file. |
| Compose project | `docker compose -p aeq-prod ps` | `app`, `evidence-parser`, `postgres`, `clamav` are `running (healthy)`. |
| Scheduler | `docker compose -p aeq-prod --profile scheduled ps scheduler` | `running (healthy)` after its 180 s start period. |

Evidence: the four command outputs, with secrets absent.

## 1. Release and health

| Check | Command | Expected |
| --- | --- | --- |
| Health reports the release | `curl -fsS http://127.0.0.1:18310/api/health` | `{"status":"ok","release":"<RELEASE_SHA>"}` |
| Images match the release | `docker inspect --format '{{.Image}}' aeq-prod-app aeq-prod-evidence-parser aeq-prod-scheduler` | Three image IDs; `app` and `scheduler` share one; record all. |
| Image labels | `docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.base.name"}}' aeq-prod-app:$RELEASE_SHA aeq-prod-evidence-parser:$RELEASE_SHA` | The pinned base images from the two Dockerfiles. |
| Database migrated | `docker compose -p aeq-prod run --rm --no-deps app node node_modules/prisma/build/index.js migrate status` | No pending migrations. |

Evidence: outputs, plus the image IDs copied into the record. The image IDs are what any security disposition must be tied to.

## 2. Evidence parser containment

The parser must be networkless, read-only, non-root, resource-limited and secret-free, reachable only through the Unix socket volume.

| Check | Command | Expected |
| --- | --- | --- |
| Network | `docker inspect --format '{{.HostConfig.NetworkMode}}' aeq-prod-evidence-parser` | `none` |
| Filesystem and privileges | `docker inspect --format '{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.CapDrop}} {{.HostConfig.SecurityOpt}} {{.Config.User}}' aeq-prod-evidence-parser` | `true [ALL] [no-new-privileges:true] 10001:2000` |
| Limits | `docker inspect --format '{{.HostConfig.PidsLimit}} {{.HostConfig.Memory}} {{.HostConfig.NanoCpus}}' aeq-prod-evidence-parser` | `32 1073741824 1000000000` |
| Environment is secret-free | `docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' aeq-prod-evidence-parser` | Only `AEQUITAS_EVIDENCE_PARSER_SOCKET`, `AEQUITAS_OCR_LANGUAGES`, `HOME`, `TMPDIR`, `NODE_ENV`, `PATH`. No database, storage, email or provider variables. |
| Socket ownership | `docker exec aeq-prod-app ls -l /run/aeq-parser/` | Socket owned by `10001:2000`, directory mode `0730`. |
| Unused and vulnerable tools absent | `docker exec aeq-prod-evidence-parser sh -c 'for b in tiff2pdf tiffcrop dirmngr gpg-agent gpgsm pinentry; do command -v $b && exit 1; done; echo absent'` | `absent` |
| Package versions for the security record | `docker exec aeq-prod-evidence-parser dpkg-query -W libtiff6 libpoppler\* libleptonica\* tesseract-ocr libxml2\*` | Versions recorded verbatim; compare with the latest [vulnerability review](candidate-container-vulnerability-review.md). |
| Extraction path works | Create a synthetic case (section 6), upload a one-page generated PDF with selectable text, then read the evidence record through the staff view. | Extraction status `extracted`, method `pdftotext`; the parser container log shows one `/extract` request. |
| TIFF is handed to staff | Upload a small synthetic TIFF to the same case. | Evidence stored, extraction `unsupported`, case marked for staff review; the parser log shows no new request. |

Evidence: outputs, the two evidence record IDs, and `docker logs --since <start> aeq-prod-evidence-parser`.

## 3. Scheduled operations

| Check | Command | Expected |
| --- | --- | --- |
| Operations completed on this release | `docker compose -p aeq-prod --profile scheduled exec -T -e SCHEDULER_READY_SINCE=<deploy start UTC> scheduler node node_modules/tsx/dist/cli.mjs scripts/verify-scheduled-ops.ts` | `All scheduled operations completed successfully on this release.` |
| Heartbeats | `docker exec aeq-prod-postgres psql -U aequitas -d aequitas -c 'select name, "lastOutcome", "lastSuccessfulAt" from "ScheduledOperationHeartbeat" order by name'` | `notification_retry` succeeded within the last 15 minutes; `case_agent` succeeded within the last 10 minutes or is recorded as disabled. |
| Case agent stays off unless fully configured | `docker exec aeq-prod-scheduler sh -c 'echo ${AEQUITAS_CASE_AGENT_ENABLED:-false}'` | `false` for this acceptance unless the hosted task records an explicit program and evaluation approval. |
| Operations page | **client:** open `/fr-CA/admin/operations` as an admin. | Both operations listed with the same timestamps as the database rows. |

Evidence: outputs and a note of the admin identity used.

## 4. Email

| Check | Command | Expected |
| --- | --- | --- |
| Provider configured | `docker exec aeq-prod-scheduler sh -c 'test -n "$RESEND_API_KEY" && test -n "$EMAIL_FROM" && test -n "$AEQUITAS_EMAIL_OUTBOX_ENCRYPTION_KEY" && echo configured'` | `configured`. Never print the values. |
| Invitation delivery | As an admin, issue an invitation to an operator-controlled mailbox from `/fr-CA/admin/invites`. | The message arrives from `EMAIL_FROM` within one `notification_retry` interval; its link opens `/fr-CA/invite/<token>`. |
| Delivery recorded | `docker exec aeq-prod-postgres psql -U aequitas -d aequitas -c 'select id, kind, "sentAt", attempts from "Notification" order by "createdAt" desc limit 3'` | The invitation row has `sentAt` set and `attempts` of 1. |
| Payload is encrypted at rest | `docker exec aeq-prod-postgres psql -U aequitas -d aequitas -c 'select id, "deliveryPayloadCiphertext" is not null as ciphertext, "deliveryPayloadNonce" is not null as nonce from "Invitation" order by "createdAt" desc limit 1'` | `ciphertext` and `nonce` are `t`; no plaintext address or token column is populated for delivery. |
| Retry on failure | Optional: with a deliberately invalid test recipient, confirm the row keeps `sentAt` null, `attempts` increases on the next run and stops at the bound in `src/lib/mail.ts`, and no stack trace or address appears in the scheduler log. | Bounded retries, no secrets in logs. |

Evidence: outbox row IDs, the scheduler log excerpt, the received message headers (not the token).

## 5. Passkeys and account recovery

| Check | Command | Expected |
| --- | --- | --- |
| Relying party matches the production hostname | `docker exec aeq-prod-app sh -c 'echo $WEBAUTHN_RP_ID $WEBAUTHN_ORIGIN $APP_URL'` | The public hostname and `https://` origin that users actually visit. |
| Enrolment | **client:** claim the invitation from section 4 on the production hostname and register a passkey. | Registration completes; the user row and credential row exist. |
| Sign-in | **client:** sign out, then sign in with that passkey at `/fr-CA/auth/sign-in`. | A session is established; `/fr-CA/cases` loads. |
| Recovery | **client:** request recovery at `/fr-CA/auth/recover`, follow the emailed link, and enrol a replacement passkey. | The old credential is revoked, the new one signs in. |
| Existing users | Before any re-enrolment of the six existing users, confirm each identity out of band. | Recorded per user; not part of a synthetic run. |

Evidence: user ID of the test account, credential IDs, and the sign-in event ID. Delete nothing; mark the test account for cleanup under the retention decision.

## 6. Routes and locales

Run with `curl -sS -o /dev/null -w '%{http_code}\n'` on CT920 against `http://127.0.0.1:18310` and, separately marked **client**, against the public hostname.

| Route | Expected |
| --- | --- |
| `/` | redirect to `/fr-CA` (next-intl routing) |
| `/fr-CA`, `/en-CA` | `200` |
| `/fr-CA/demo`, `/en-CA/demo` | `200` on releases that include the fictional case demo. On the current production release `d74ed34` they return `404` because the demo arrived with PR #14; that is expected until a release containing it is deployed. |
| `/fr-CA/auth/sign-in` | `200` |
| `/fr-CA/cases` without a session | redirect to sign-in |
| `/api/health` | `200` with the release SHA |
| `/api/cases` without a session | `401` with `Not authenticated.` |

Then, as the test user, create one case at `/fr-CA/cases/new` with clearly synthetic party names, use it for sections 2 and 7, and close it when done. Record its case ID.

Evidence: status codes for both origins, kept in separate columns, and the case ID.

## 7. Evidence integrity

| Check | Command | Expected |
| --- | --- | --- |
| Event hash chain | `docker compose -p aeq-prod run --rm --no-deps app node node_modules/tsx/dist/cli.mjs scripts/verify-events.ts` | Chain verifies from `HASH_CHAIN_GENESIS` with no breaks. |
| Stored evidence files | `docker compose -p aeq-prod run --rm --no-deps app node node_modules/tsx/dist/cli.mjs scripts/verify-evidence-files.ts` | Every evidence record has its file and matching digest. |
| New events carry no case content | `docker exec aeq-prod-postgres psql -U aequitas -d aequitas -c 'select type, payload from "Event" where "caseId" = '"'"'<case ID>'"'"' order by "createdAt"'` | `CASE_CREATED` payload is empty; chronology events hold only row IDs. |
| ClamAV | `docker exec aeq-prod-clamav clamdcheck.sh && docker exec aeq-prod-clamav sh -c 'ls -l /var/lib/clamav/*.cvd /var/lib/clamav/*.cld 2>/dev/null'` | Daemon healthy; signature files dated within the last 7 days. |

Evidence: outputs.

## 8. Backup and restore

| Check | Command | Expected |
| --- | --- | --- |
| Nightly backup ran | `ls -l $BACKUP_ROOT/daily/ | tail -3` and `cat $BACKUP_ROOT/daily/<newest>/SHA256SUMS` | A directory from the last 24 h with `aequitas.dump`, `evidence.tar` and matching sums. |
| Checksums | `(cd $BACKUP_ROOT/daily/<newest> && sha256sum -c SHA256SUMS)` | `OK` for both files. |
| Off-box copy | `deploy/ct920/backup-offbox.sh` log from the last run | Verified copy present on the NFS target. |
| Restore drill | Only in a disposable clone of the stack (a separate compose project name and volumes), run `deploy/ct920/verify-restore.sh --confirm-production-replacement <dump> <evidence.tar>` and the two verification scripts from section 7. | Row counts match `deploy/ct920/row-counts.sql`; chain and files verify. |

Never run `verify-restore.sh` against `aeq-prod` as part of acceptance; it replaces the live database. Record the clone's project name and that it was removed afterwards.

Evidence: listings, checksum output, restore-drill log.

## 9. Retention and deletion

No retention schedule or case-deletion service exists at this head; see [retention and deletion design](retention-deletion-design.md). Until Martin and the privacy or legal reviewers approve the written policy, this section records the gate as open and the synthetic records created above as awaiting that decision. Once a deletion release ships, replace this section with its acceptance gates from that document: a deletion request against the synthetic case, per-store receipts, retained minimal receipt only, and a backup restore that does not resurrect the deleted content.

Evidence: the case ID and test user ID from sections 5 and 6, flagged for cleanup.

## 10. Closing the record

1. Fill the one-line-per-check table with pass, fail or not applicable and the evidence pointers.
2. Write a hosted task checkpoint that names the release SHA, the image IDs from section 1, the parser package versions from section 2, and any failed or skipped step. Keep client observations in their own lines.
3. A failed step in sections 1, 2, 3, 5 or 7 blocks any readiness claim for that release. A failed step in 4, 6 or 8 blocks it unless the owner records an accepted exception with a date to retest.
4. The record does not approve merge, deployment, real case data or live model use. Those stay with their named approvers in [paid-pilot readiness](paid-pilot-readiness.md).
