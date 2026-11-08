# Retention and deletion: decision draft

**Status:** engineering inventory and proposed target design; not an approved retention policy, legal opinion, privacy assessment, or deletion procedure.

**Revalidated:** current branch head `8c111d74f11bb78c898bc6cdb55480abaaf231df` on 2026-11-08. Comparing source from the previous review anchor `d6300fb6337fc90e45f67a113419710c21e6476d` to this head found no changes in `prisma/schema.prisma`, `src/domain`, `src/lib`, or `deploy/ct920`. Three changes are limited to the synthetic evaluation fixture/review protocol; the current evaluator's test-database and local-report behavior is recorded below. The latest recorded read-only CT920 runtime check is documented in [`docs/paid-pilot-readiness.md`](paid-pilot-readiness.md#current-verification-2026-11-08-0430-utc); it reported the existing app on release `d74ed342693a96a6dc75d8907d288131c0148385`. No production database, object store, backup contents, provider account, email account, or production logs were inspected in this recheck.

## Current-source recheck

The current Prisma schema still has no case-retention policy, due date, legal-hold field, or purge state. The case data remains distributed across the tables listed below, and account identity is shared across case relations. No retention coordinator, deletion-request endpoint, or case purge path exists in the current source.

The current source confirms that `CASE_DETAILS_UPDATED` stores before-and-after case details including the dispute description, respondent email, respondent name, and party ID in the event payload (`src/domain/caseDetails.ts`). Agent-processing acceptance also stores the exact configured notice in the event payload (`src/domain/caseAgent/agent.ts`). The agent's `RECOMMENDATION_DRAFTED` event stores an unkeyed SHA-256 digest of the case material sent to the model; treat it as potentially linkable, not anonymous. `AGENT_ENROLLED` now stores a versioned policy snapshot containing the amount ceiling, response periods, withdrawal rule and consent-only rule; it contains no party-submitted text. The event hash continues to cover canonical JSON payload and actor ID (`src/domain/events.ts`). Migrations still install append-only triggers for both `Event` and `ChronologyEntry`.

The current data-related source paths still contain no case-retention schedule, deletion-request endpoint, or case purge support. The existing event payload copies of case text and identifiers remain. The unchanged `AGENT_ENROLLED` event stores a versioned program policy snapshot, and `AGENT_PROCESSING_ACCEPTED` stores the exact configured provider notice, locale and provider identity; neither change establishes a retention period.

The read-only CT920 check on 2026-11-07 found the clean production checkout on `ship/aequitas-pr5-d74ed34` at `d74ed342693a96a6dc75d8907d288131c0148385`, with `aeq-prod-app` healthy and no agent scheduler container, matching user timer, or matching task in the user crontab. A 03:15 off-box backup cron entry was present. The candidate `backup.sh` retains 14 local daily and 8 local weekly copies. `backup-offbox.sh` copies each daily backup to the NFS target and verifies its checksums, but defines no off-site pruning. The runtime check did not verify that backups completed, inspect NFS contents, or establish any separately configured NFS expiry. It also did not verify production database migrations, object-store versions, email/provider retention, or logs.

`src/lib/storage.ts` still provides object deletion for rollback, with no retention coordinator or case purge caller. Evidence and export storage keys remain case-derived. These source checks do not establish whether production has separate controls or which copies, backups, and provider records exist.

## Release position

The application has no case-retention schedule or case-deletion service. No case-record retention periods are configured. The append-only event log and chronology table can contain case text, and sealed exports reproduce case content. A case cannot currently be erased by removing one database row.

Do not use real case data until the program and counsel approve the applicable schedule, the owner chooses how auditability interacts with erasure, and the operator verifies every storage and provider copy path. `docs/paid-pilot-readiness.md` lists the outstanding privacy and hosting gates.

## Current data inventory

This map identifies repository storage paths. It does not prove what exists in a live deployment or which external systems retain copies.

| Data | Current location and copies | Evidence |
| --- | --- | --- |
| Account and authentication | `User` stores email, display name, locale and role. `WebAuthnCredential` stores a credential ID, public key and counter. Invitation and account-recovery rows retain token hashes and lifecycle timestamps. While delivery is pending, those rows also hold an AES-GCM encrypted exact provider payload containing the recipient and one-time link; the key is HKDF-derived from the distinct 32-byte-minimum `AEQUITAS_EMAIL_OUTBOX_ENCRYPTION_KEY`, shared by the web app and scheduled mail worker, and the payload is cleared after acceptance, permanent delivery failure, revocation/use, or expiry cleanup. If that worker stops, expired ciphertext can remain until it runs again. User IDs are referenced by cases and records. | `prisma/schema.prisma` (`User`, `WebAuthnCredential`, `Invitation`, `AccountRecovery`); `src/lib/emailPayload.ts`; `src/lib/mail.ts`; `scripts/deliver-notifications.ts` |
| Case intake and parties | `Case` stores a reference number, category, dispute description, amount, metadata JSON, party and manager IDs, workflow state and agent scheduling/escalation fields. `CASE_CREATED` and `CASE_DETAILS_UPDATED` events can also contain the dispute description and respondent name/email. | `prisma/schema.prisma` (`Case`); `src/domain/mutate.ts`; `src/domain/caseDetails.ts` |
| Party submissions | Position bodies are stored in `PositionStatement`. Chronology titles and descriptions are stored in `ChronologyEntry`; the submission event also stores the parsed chronology fields. Consent records include authentication context, outcome/version references and any revocation reason. | `prisma/schema.prisma`; `src/domain/mutate.ts` |
| Evidence and extracted text | `EvidenceItem` stores title, description, storage key, content hash, MIME type, scan status and submitter. Original files are stored separately under case-derived object keys. Phase 1 `Source`, `ClaimEvidenceLink` and pipeline records can hold bodies, text, excerpts, rationale, proposal JSON and synthesis text derived from the file. | `prisma/schema.prisma`; `src/lib/storage.ts`; `src/domain/claimWrites.ts`; `src/domain/pipeline/writes.ts` |
| Recommendations and party outcomes | `Recommendation.explanation` is JSON; party outcomes store rendered text; citations retain evidence pointers, excerpt offsets and hashes. Review records may contain rationale and snapshots. Contestations store grounds, response and overrule reason. | `prisma/schema.prisma` (`Recommendation`, `PartyOutcome`, `PartyOutcomeCitation`, `ReviewTrail`, `Contestation`) |
| Workflow audit | `Event` stores case ID, actor ID, event type, JSON payload, sequence, timestamps and hashes. Some event payloads contain personal or substantive text, including case descriptions, chronology details, contestation text, notes, intake override reasons and synthesis diagnostics. `AGENT_PROCESSING_ACCEPTED` also stores the party's exact configured provider notice, locale, provider/account/model identity, prompt version and notice hash. `RECOMMENDATION_DRAFTED` includes an unkeyed digest of model input; `AGENT_ENROLLED` includes a program policy snapshot. Actor and case identifiers remain linkable even where payloads contain only IDs. | `src/domain/events.ts`; `src/domain/mutate.ts`; `src/domain/caseAgent/agent.ts`; `src/domain/caseDetails.ts`; `src/domain/resolution.ts`; `src/domain/pipeline/writes.ts` |
| Sealed exports | An `ExportBundle` row points to a ZIP in object storage. The ZIP contains JSON, PDF and verification text. The JSON record includes party names/emails, the full event payload timeline, evidence metadata, chronology, positions and recommendation history. The hash detects changes; it does not delete or encrypt the export. | `src/domain/exportBundle.ts`; `prisma/schema.prisma` (`ExportBundle`) |
| Backups | The candidate deployment script writes nightly PostgreSQL dumps and an evidence-volume tar, retaining 14 daily and 8 Sunday weekly copies on the local backup target. The off-site script copies and checksum-verifies each daily copy to an NFS target; it has no remote pruning step. The installed schedule and actual NFS expiry are separate operational facts that remain unverified. Backup rotation does not delete case records from the live database or object store. | `deploy/ct920/backup.sh`; `deploy/ct920/backup-offbox.sh`; `docs/ct920-standup.md` |
| Messaging and operations | Notification rows retain user/case IDs, kind, locale, attempt counts and timestamps. Invitation and recovery emails are sent through Resend. The case agent can send case material to the configured Gemini Developer API, Google Cloud Vertex AI, or Workers AI account only after both parties accept the current provider notice. Provider-side retention, account logs, email retention and infrastructure logs are not verified here; Vertex also has a separate operator attestation for the exact project's data-handling settings. | `src/lib/mail.ts`; `src/domain/caseAgent/agent.ts`; `src/domain/pipeline/provider.ts`; `docs/case-agent-prototype.md` |
| Operational metrics and scheduler health | `CaseAgentDailyUsage` retains one aggregate model-call count per UTC day, with no case, user, token or cost fields. `ScheduledOperationHeartbeat` keeps one aggregate row per scheduled operation with interval, start/heartbeat/finish/success timestamps, outcome and exit code; it has no case or party identifiers. The source contains no age-based cleanup for these rows. The daily counter is not a provider-dollar ledger. | `prisma/schema.prisma`; `src/domain/caseAgent/modelBudget.ts`; `src/domain/scheduledOperations.ts`; `scripts/scheduled-ops.ts` |
| Synthetic evaluation artifacts | `scripts/evaluate-case-agent.ts` points writes to a database whose name must end in `_test`; it creates synthetic users, cases and events but does not remove those rows. On normal completion or handled failure it removes the temporary evidence directory and clears the test daily-usage row. An optional `--review-report` writes generated claims, outcomes and exact excerpts from synthetic evidence to a caller-selected local path with mode `0600`. The report excludes prompts, full evidence, case/party IDs and credentials; it redacts common contact patterns, but that redaction is not comprehensive. The report persists until the operator removes it. | `test/testDatabaseUrl.ts`; `scripts/evaluate-case-agent.ts`; `scripts/caseAgentEvaluationReview.ts`; `docs/case-agent-prototype.md` |

## Deletion and audit behavior observed

- `src/lib/storage.ts` exposes `deleteBuffer()`, but the repository uses it through `rollbackBuffer()` to clean up an object after a failed write. It is not a case lifecycle or deletion service.
- Several research/traceability models have `deletedAt` fields. Those are soft-delete markers: the content remains in the database, related events remain, and existing exports are unaffected.
- A database trigger rejects updates and deletes on `Event`. A second trigger makes `ChronologyEntry` append-only. Event hashes cover the canonical JSON payload, actor ID, sequence and timestamp (`src/domain/events.ts`). Removing or changing a historical event payload would break the current chain's verification.
- Event and case foreign keys, plus the absence of a coordinated deletion path, mean a user or case row cannot safely be removed in isolation.
- The sealed export is an additional content copy. Evidence and export objects use keys containing the case ID. Object-store versioning, backups, disaster-recovery copies, and their expiration settings were not inspected.
- The source review found no live-case retention job, deletion-request endpoint, or case purge coordinator. The candidate provides bounded local backup rotation, but its off-site copy script does not prune and any external NFS retention remains unknown. The synthetic evaluator's `_test` database guard, temporary-directory cleanup and optional report file are test/evaluation controls, not a production data-lifecycle service. This is repository evidence, not proof that the deployed host has no separate operational controls.

## Proposed target for new records

Use two deliberately separate layers:

1. **Case-content vault.** Store party identities, submissions, evidence, extracted text, recommendations, outcomes, contestations, exports and other case content in a separately managed data layer. Encrypt each case's content with a separately revocable case key held by the deployment's key-management service. Use opaque storage object identifiers rather than case IDs in object keys. The selected provider and key-management service still require operator and counsel review.
2. **Minimal audit ledger.** Keep the append-only event chain, but constrain event payloads to workflow facts, opaque record references, keyed content digests where they are needed, and actor references required to verify sequence and authority. Do not copy names, email addresses, free-text descriptions, positions, reasons, excerpts or model text into event payloads. Treat IDs and digests as potentially linkable until the privacy owner decides otherwise.
3. **Retention coordinator.** Add a policy-versioned schedule by record category and lifecycle event, plus legal-hold and exception handling. A deletion request must be idempotent, report progress for each data store, and fail closed if a required copy cannot be located or removed. It should remove content rows and object versions, exports and derived text; destroy the case key when policy permits; record only the minimum deletion receipt approved by counsel; and reconcile backups as they expire. Do not claim immediate erasure while a backup or provider copy remains.
4. **Party access and correction.** Define the authenticated request path for access, correction, export and deletion, including who reviews exceptions and how the party receives a completion or refusal notice. Keep the party-facing process separate from staff-only operational details.

This is a proposed architecture, not an implementation. Crypto-erasure is not automatically equivalent to legal or operational erasure; retained identifiers, digests, access logs, provider copies and backups all need an explicit decision.

## Historical records need a separate decision

The current event payloads already contain content, and old sealed exports can contain copies of those payloads. Moving future data into a vault does not solve this history. Before implementing deletion, the owner, privacy officer and counsel must choose a governed path for old records:

- keep the legacy chain restricted until the approved schedule and any holds permit a reviewed purge or re-sealing operation; this preserves the old verification only while the content is retained; or
- migrate to a new minimized ledger under a reviewed process that verifies and checkpoints the old chain, records what was removed and what proof remains, then validates the new ledger before the old content copies are purged.

The application currently implements neither path. An ordinary `UPDATE` or `DELETE` against the event table is blocked and would invalidate the existing evidence model.

## Decisions to record before implementation

| Decision | Accountable reviewer | Needed answer |
| --- | --- | --- |
| Responsible organization and applicable privacy regime | Program owner and counsel/privacy officer | Which organization controls each record, and which legal regime applies to this program? |
| Retention schedule | Program owner and counsel/privacy officer | For each record category, what event starts retention, what period applies, and what exceptions or legal holds pause deletion? |
| Decision record and appeal history | Counsel/privacy officer and program owner | Which submitted material, recommendation, consent, appeal and audit facts must remain available, and for whom? |
| Existing event-chain treatment | Product owner, counsel/privacy officer and audit owner | May old content be retained, or is a reviewed re-sealing/migration acceptable? What proof must survive? |
| Shared user accounts | Program owner and counsel/privacy officer | How should one person's account details be corrected or removed when the account appears in multiple cases? |
| Storage and provider copies | Deployment operator and provider/privacy reviewer | Where are the database, objects, backups, logs, email records and model requests stored, and what are their actual retention/deletion controls? |
| Party request workflow | Program owner and counsel/privacy officer | Who receives requests, verifies identity, handles holds/exceptions, performs the action and communicates the outcome? |

No retention period or legal answer is supplied by this document.

## Acceptance gates for a deletion release

1. The decision table is approved and translated into a versioned schedule with a named responsible role for each record category.
2. New writes no longer place substantive case text or identifiers in immutable event payloads unless an approved policy specifically requires them.
3. A synthetic-case deletion test accounts for the database, event chain, evidence objects and versions, derived text, exports, notification records, application logs, backups, email provider and model provider.
4. The test proves that the workflow handles a legal hold, an overdue deletion, a partial store failure, a retry, and a restore from backup without silently resurrecting deleted content.
5. Independent verification confirms the allowed audit receipt remains valid and contains no prohibited personal content; party access/correction/export behavior is checked against the approved process.
6. The deployment operator verifies live settings and provider/backup deletion terms before real case data is allowed.

Until these gates are met, retention/deletion remains a release blocker for real cases. This document does not authorize a live provider call, production inspection, deployment, merge, or use of real case data.
