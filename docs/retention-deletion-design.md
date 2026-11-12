# Reviewed case retention and deletion

## Selected policy and scope

Martin's 2026-11-12 instruction to “decide with measure” supersedes the original handoff's seven-year automatic anonymization rule. Policy `measured-review-2026-11-12-v1` schedules a review at the first calendar anniversary of closure (February 28 for a leap-day closure). Time alone never authorizes deletion. An administrator must record the applicable hold review and an evidence-bound, case-specific whole-case disposal decision. This is an engineering review default, not a universal legal retention period.

The initial release remains a single-program synthetic pilot. A real program must determine its applicable records obligations before authorizing actual disposal. Active cases, unresolved contestations, unknown or active holds, future review dates, and unfinished or uncertain operations block erasure. Holds never expire automatically. Synthetic fixtures use genuinely old closure dates; there is no production bypass or force switch.

## Implementation

`CaseDeletion` stores the policy, review date, hold state, approval and progress. Decisions are append-only and refer to SHA-256 digests of separately controlled review evidence. Parties can submit an authenticated request through `POST /api/cases/{caseId}/deletion`; the same endpoint's GET reports progress to parties and administrators. It does not grant deletion authority. Requests are idempotent per case.

The operator workflow is `npm run privacy:retention -- <action> ...`:

1. `request <case-id> <actor-id>` creates a request with UNKNOWN hold status.
2. `hold <deletion-id> <admin-id> CLEAR|HELD|UNKNOWN <evidence-sha256>` records a review. Any change invalidates the prior approval.
3. `approve <deletion-id> <admin-id> <decision-sha256>` records a case-specific disposal decision after checking the review date, closure and contestations.
4. `freeze <deletion-id> <admin-id>` closes the case to new operations. Existing operations remain visible until settled; frozen content is unavailable through normal readers, exports and background work.
5. `inventory <deletion-id> <admin-id>` verifies the event chain and source revisions, rejects cross-case references, waits for durable operations to drain, and inventories registered objects, attempted-write keys and all keys under the case's storage namespaces.
6. `erase-objects <deletion-id> <admin-id>` commits the independent tombstone before destructive I/O, removes every object version/delete marker or local file, and records verified absence. Each object operation serializes with a new hold; a hold prevents the next operation but cannot undo an already completed one. Failure leaves the case frozen and the job retryable.
7. `purge-database <deletion-id> <admin-id>` rechecks storage absence and calls the separately authorized SQL procedure. This removes the complete case graph, including historical event payloads, chronology, source revisions, soft-deleted content, stored exports and notification rows. It preserves shared accounts/authentication, other cases and aggregate scheduler/model-usage records.
8. `attest <deletion-id> <admin-id> <store> <status> <evidence-sha256>` records the operator's assertion about each external copy after local purge. `complete <deletion-id> <admin-id>` refuses any pending copy.
9. `status <deletion-id> <admin-id>` prints progress without case content, storage keys or evidence text.

A crashed operation stays ACTIVE; a failed or uncertain external effect stays UNCERTAIN. It does not become safe because a lease expires. `resolve-operation <operation-id> <admin-id> <evidence-sha256> quiescence-confirmed` requires the operator to establish that the originating process and all delegated I/O have stopped. That is explicitly an operator assertion, retained in the decision trail. Deployments must drain old application versions that predate operation tracking before enabling erasure.

## Database authority

Migrations install write barriers and preserve the ordinary append-only Event and ChronologyEntry rules. The whole-case purge is a narrowly scoped SECURITY DEFINER function whose default PUBLIC execution is revoked. It refuses execution until transferred to the restricted NOLOGIN `aequitas_erasure_owner` role.

A database owner runs `deploy/retention/provision-purger.sql` with explicit existing runtime and purger login names. Neither login may own database objects, have elevated privileges or role memberships. The web login cannot execute the purge. The purger login receives procedure execution, not table writes. No trigger disabling, `session_replication_role`, or caller-controlled authorization flag is used by erasure.

The operator process alone receives `RETENTION_PURGER_DATABASE_URL`, different from `DATABASE_URL`. Never put it or a migration-owner connection in the app's shared `.env`. Changing a currently owner-privileged runtime to the reviewed role layout is a separate deployment operation. Merely applying migrations does not establish role separation.

The procedure checks its authorization, hold, inventory, operation state, cross-case references, unresolved contestations and the expected case-table inventory before deleting. Future direct Case foreign-key tables cause refusal until this inventory is updated. Minimal restricted receipts retain opaque case/actor identifiers, policy, dates, decisions and counts; they are linkable operational data, **not anonymized records**. Storage keys and operation intents are removed after verified local purge. The deleted historical event chain is not represented as still available or independently verifiable.

## Independent ledger and restore protection

Before enabling erasure, configure `RETENTION_ENFORCEMENT_ENABLED=true` and an absolute `RETENTION_LEDGER_PATH`. Initialize a new mode-0600 ledger with `npm run privacy:restore -- initialize`. Keep this ledger in a separately controlled, independently replicated store that is never rolled back with the case database or evidence volume. CT920 Compose provides a separate read-only mount to app and scheduler; the operator process needs its own writable mount. Provision the directory ownership before enabling the flag. A named volume alone is not proof of off-host replication.

The coordinator atomically writes and fsyncs an independent tombstone before erasing any bytes. A writer lock is never stolen by timeout. Application instrumentation and both scheduler/direct worker entrypoints verify this ledger before serving or dispatching work. Missing, unsafe, inconsistent or unreplayed ledgers stop startup while enforcement is enabled. The deployment must retain the flag and current ledger through recovery.

After restoring a database/evidence backup, keep the app, scheduler and other workers stopped. Verify the current ledger digest against the independently retained operator record, then run:

```text
npm run privacy:restore -- replay <admin-id> <expected-ledger-sha256> services-stopped
npm run privacy:restore -- verify
```

Replay restores tombstones and quarantines any resurrected case. An independently restored old object archive beside a post-purge database reopens the residual-copy record and blocks startup. After a fresh hold review, `npm run privacy:restore -- reconcile-objects <deletion-id> <admin-id> <review-evidence-sha256> services-stopped` erases only that tombstoned namespace; external-copy attestations remain pending. It invalidates old approvals; it does not invent permission to dispose of a changed backup, waive holds or declare restored files erased. Existing operation records still require proven quiescence. A backup predating the case also receives a tombstone, preventing later creation under that ID. Complete the reviewed inventory/erasure workflow against restored copies before claiming their disposal. Restore scripts leave services stopped; replay and verification are required before restart.

## External copies and completion meaning

The required copy inventory is: DATABASE_BACKUPS, OBJECT_SNAPSHOTS, PARSER_SCRATCH, APPLICATION_LOGS, EMAIL_PROVIDER, MODEL_PROVIDER, DOWNLOADED_EXPORTS and EXTERNAL_REFERENCES. Controlled stores must be evidenced as absent or deleted. Only downloaded exports and external references can be explicitly classified OUTSIDE_CONTROL. The case coordinator never follows arbitrary external URLs to delete someone else's records.

Attestations are recorded as operator assertions, not automated provider proof. COMPLETED means the controlled scope is reconciled with the recorded evidence; any OUTSIDE_CONTROL copies remain visible. It does not claim global erasure of recipients' copies. Shared accounts, passkeys, invitations and account recovery are a separate account lifecycle because they can support other cases.

The parser scratch volume, application logs, backup retention and actual email/model-provider settings require deployment-specific checks. The previous backup scripts retain 14 daily and 8 weekly local backups; the off-box copier does not implement pruning. A copy remains pending until its actual expiry or disposal is verified. Existing downloaded exports and old backups remain copies even if new events minimize content.

## Validation and release boundary

Focused tests cover versioned storage, safe local paths, role separation, freeze/drain behavior, legal holds, partial failures/retries and backup quarantine. The current implementation must pass integrated exact-commit CI and the target deployment checks before release. This document describes source behavior; it does not certify production configuration or authorize live erasure. Actual results belong in the release receipt.
