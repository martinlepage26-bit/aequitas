# Retention and deletion: decision draft

**Status:** engineering inventory and proposed target design; not an approved retention policy, legal opinion, privacy assessment, or deletion procedure.

**Inspected:** branch head `ed02a79` on 2026-11-06. This review covers the repository only. It did not inspect a deployed database, object store, backup, provider account, email account, or production logs. The live host and its data state remain unverified.

## Release position

The application has no case-retention schedule or case-deletion service. No case-record retention periods are configured. The append-only event log and chronology table can contain case text, and sealed exports reproduce case content. A case cannot currently be erased by removing one database row.

Do not use real case data until the program and counsel approve the applicable schedule, the owner chooses how auditability interacts with erasure, and the operator verifies every storage and provider copy path. `docs/paid-pilot-readiness.md` lists the outstanding privacy and hosting gates.

## Current data inventory

This map identifies repository storage paths. It does not prove what exists in a live deployment or which external systems retain copies.

| Data | Current location and copies | Evidence |
| --- | --- | --- |
| Account and authentication | `User` stores email, display name, locale and role. `WebAuthnCredential` stores a credential ID, public key and counter. Invitation and account-recovery rows retain token hashes and lifecycle timestamps. User IDs are referenced by cases and records. | `prisma/schema.prisma` (`User`, `WebAuthnCredential`, `Invitation`, `AccountRecovery`) |
| Case intake and parties | `Case` stores a reference number, category, dispute description, amount, metadata JSON, party and manager IDs, workflow state and agent scheduling/escalation fields. `CASE_CREATED` and `CASE_DETAILS_UPDATED` events can also contain the dispute description and respondent name/email. | `prisma/schema.prisma` (`Case`); `src/domain/mutate.ts`; `src/domain/caseDetails.ts` |
| Party submissions | Position bodies are stored in `PositionStatement`. Chronology titles and descriptions are stored in `ChronologyEntry`; the submission event also stores the parsed chronology fields. Consent records include authentication context, outcome/version references and any revocation reason. | `prisma/schema.prisma`; `src/domain/mutate.ts` |
| Evidence and extracted text | `EvidenceItem` stores title, description, storage key, content hash, MIME type, scan status and submitter. Original files are stored separately under case-derived object keys. Phase 1 `Source`, `ClaimEvidenceLink` and pipeline records can hold bodies, text, excerpts, rationale, proposal JSON and synthesis text derived from the file. | `prisma/schema.prisma`; `src/lib/storage.ts`; `src/domain/claimWrites.ts`; `src/domain/pipeline/writes.ts` |
| Recommendations and party outcomes | `Recommendation.explanation` is JSON; party outcomes store rendered text; citations retain evidence pointers, excerpt offsets and hashes. Review records may contain rationale and snapshots. Contestations store grounds, response and overrule reason. | `prisma/schema.prisma` (`Recommendation`, `PartyOutcome`, `PartyOutcomeCitation`, `ReviewTrail`, `Contestation`) |
| Workflow audit | `Event` stores case ID, actor ID, event type, JSON payload, sequence, timestamps and hashes. Some event payloads contain personal or substantive text, including case descriptions, chronology details, contestation text, notes, intake override reasons and synthesis diagnostics. Actor and case identifiers remain linkable even where payloads contain only IDs. | `src/domain/events.ts`; `src/domain/mutate.ts`; `src/domain/caseDetails.ts`; `src/domain/resolution.ts`; `src/domain/pipeline/writes.ts` |
| Sealed exports | An `ExportBundle` row points to a ZIP in object storage. The ZIP contains JSON, PDF and verification text. The JSON record includes party names/emails, the full event payload timeline, evidence metadata, chronology, positions and recommendation history. The hash detects changes; it does not delete or encrypt the export. | `src/domain/exportBundle.ts`; `prisma/schema.prisma` (`ExportBundle`) |
| Messaging and operations | Notification rows retain user/case IDs, kind, locale, attempt counts and timestamps. Invitation and recovery emails are sent through Resend. The case agent can send case material to the configured Gemini or Workers AI account. Provider-side retention, account logs, email retention, infrastructure logs and backup expiry are not verified here. | `src/lib/mail.ts`; `src/domain/caseAgent/agent.ts`; `src/domain/pipeline/provider.ts`; `docs/case-agent-prototype.md` |

## Deletion and audit behavior observed

- `src/lib/storage.ts` exposes `deleteBuffer()`, but the repository uses it through `rollbackBuffer()` to clean up an object after a failed write. It is not a case lifecycle or deletion service.
- Several research/traceability models have `deletedAt` fields. Those are soft-delete markers: the content remains in the database, related events remain, and existing exports are unaffected.
- A database trigger rejects updates and deletes on `Event`. A second trigger makes `ChronologyEntry` append-only. Event hashes cover the canonical JSON payload, actor ID, sequence and timestamp (`src/domain/events.ts`). Removing or changing a historical event payload would break the current chain's verification.
- Event and case foreign keys, plus the absence of a coordinated deletion path, mean a user or case row cannot safely be removed in isolation.
- The sealed export is an additional content copy. Evidence and export objects use keys containing the case ID. Object-store versioning, backups, disaster-recovery copies, and their expiration settings were not inspected.
- The source review found no live-case retention job, deletion-request endpoint, case purge coordinator, or backup-expiry policy. Test/evaluation cleanup is not a production data-lifecycle control. This is repository evidence, not proof that the deployed host has no separate operational controls.

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
