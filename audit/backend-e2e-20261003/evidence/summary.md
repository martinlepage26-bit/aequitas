| Suite | Tests | Passed | Failed |
|---|---:|---:|---:|
| 00-harness-smoke | 1 | 1 | 0 |
| 01-http-production | 84 | 83 | 1 |
| 02-authentication | 32 | 27 | 5 |
| 03-invitations-email | 31 | 27 | 4 |
| 04-case-workflows | 23 | 20 | 3 |
| 05-authorization | 33 | 30 | 3 |
| 06-evidence-storage-local | 38 | 26 | 12 |
| 06-evidence-storage-s3 | 38 | 25 | 13 |
| 07-ai-and-concurrency | 34 | 25 | 9 |
| 08-integrity | 11 | 10 | 1 |
| 10-input-robustness | 4 | 1 | 3 |
| 11-mail-not-configured | 3 | 3 | 0 |
| **Total** | **332** | **278** | **54** |

## Failing tests (each is a confirmed finding or a facet of one)

- `01-http-production` — unsupported methods, oversized requests and file exposure the documented POST /api/cases/:id/recommendation alias exists (docs/aequitas-core-backend.md says it does)
- `02-authentication` — sign-in (real WebAuthn assertions) REPLAY, counter-less authenticator (signCount always 0, e.g. synced passkeys): the same assertion + challenge cookie must be refused
- `02-authentication` — expired, malformed, replayed and wrong-purpose tokens observation: a correctly signed session for a user that does not exist
- `02-authentication` — session lifetime and revocation sign-out accepts a same-origin browser POST arriving through a TLS-terminating proxy (Origin == public Host)
- `02-authentication` — session lifetime and revocation a copied session cookie stops working after sign-out (server-side revocation)
- `02-authentication` — session lifetime and revocation a changed global role takes effect immediately (cookie role is not trusted for 7 days)
- `03-invitations-email` — claiming an invitation (real WebAuthn) concurrent invitations for the same new address do not 500
- `03-invitations-email` — a respondent named by a complainant becomes a working account only through an invitation naming an EXISTING respondent with different letter case reaches that same account, not a duplicate placeholder
- `03-invitations-email` — a respondent named by a complainant becomes a working account only through an invitation a placeholder typed with capital letters can still be invited and then sees its case (addresses are case-insensitive)
- `03-invitations-email` — case notifications: transactional outbox, retries, no case content one permanently failing recipient must not block every other recipient's notifications (head-of-line blocking)
- `04-case-workflows` — repeat and refused operations have no side effects repeating a withdrawal is idempotent: no second CASE_WITHDRAWN event and no second notification
- `04-case-workflows` — repeat and refused operations have no side effects a refused close (case not in a closable state) generates no export bundle row or object
- `04-case-workflows` — repeat and refused operations have no side effects closing an already closed case does not generate and store another export bundle
- `05-authorization` — denial uniformity on write endpoints (no existence oracle) an outsider gets the same answer for a real case id and a non-existent one on every mutation route
- `05-authorization` — denial uniformity on write endpoints (no existence oracle) issuing: an unrelated manager cannot tell a real recommendation id from a made-up one
- `05-authorization` — pages: case list and workspace projection a respondent cannot see a case the complainant has not submitted yet (existence, reference number, complainant name)
- `06-evidence-storage-local` — invalid evidence is refused before anything is stored path-like names are inert: filename, title and description never influence the storage key
- `06-evidence-storage-local` — size limits (stated limit: 25 MB) 11 MiB (above Next.js's default 10 MB proxy buffer): accepted with full integrity
- `06-evidence-storage-local` — size limits (stated limit: 25 MB) 24 MiB: accepted with full integrity
- `06-evidence-storage-local` — size limits (stated limit: 25 MB) exactly 25 MiB: accepted with full integrity
- `06-evidence-storage-local` — malware (EICAR through the real clamd) an EICAR upload is rejected: it must not be stored, listed or exported as evidence, and the uploader must be told
- `06-evidence-storage-local` — failure handling and cleanup (existing objects are never deleted) export-record failure: the generated archive is removed, the case is not closed, no row or event is left, and the error does not leak internals
- `06-evidence-storage-local` — export bundle: contents, integrity and what each reader may learn CONFIDENTIALITY: a party's export does not contain the counterparty's e-mail address
- `06-evidence-storage-local` — export bundle: contents, integrity and what each reader may learn CONFIDENTIALITY: a party's export does not contain private reviewer notes
- `06-evidence-storage-local` — export bundle: contents, integrity and what each reader may learn CONFIDENTIALITY: a party's export does not contain unissued or superseded AI drafts
- `06-evidence-storage-local` — export bundle: contents, integrity and what each reader may learn CONFIDENTIALITY: a party's export does not list the counterparty's rejected (infected) uploads
- `06-evidence-storage-local` — export bundle: contents, integrity and what each reader may learn CONFIDENTIALITY: a party's export timeline withholds the event types the live API withholds (NOTE_ADDED, RECOMMENDATION_DRAFTED)
- `06-evidence-storage-local` — export bundle: contents, integrity and what each reader may learn AVAILABILITY: generating an export for a record with long unbroken text does not freeze the whole server
- `06-evidence-storage-s3` — invalid evidence is refused before anything is stored path-like names are inert: filename, title and description never influence the storage key
- `06-evidence-storage-s3` — size limits (stated limit: 25 MB) 11 MiB (above Next.js's default 10 MB proxy buffer): accepted with full integrity
- `06-evidence-storage-s3` — size limits (stated limit: 25 MB) 24 MiB: accepted with full integrity
- `06-evidence-storage-s3` — size limits (stated limit: 25 MB) exactly 25 MiB: accepted with full integrity
- `06-evidence-storage-s3` — malware (EICAR through the real clamd) an EICAR upload is rejected: it must not be stored, listed or exported as evidence, and the uploader must be told
- `06-evidence-storage-s3` — failure handling and cleanup (existing objects are never deleted) export-record failure: the generated archive is removed, the case is not closed, no row or event is left, and the error does not leak internals
- `06-evidence-storage-s3` — failure handling and cleanup (existing objects are never deleted) object store unavailable (MinIO stopped): uploads and exports fail with no partial state, the store recovers, and client errors do not reveal the store
- `06-evidence-storage-s3` — export bundle: contents, integrity and what each reader may learn CONFIDENTIALITY: a party's export does not contain the counterparty's e-mail address
- `06-evidence-storage-s3` — export bundle: contents, integrity and what each reader may learn CONFIDENTIALITY: a party's export does not contain private reviewer notes
- `06-evidence-storage-s3` — export bundle: contents, integrity and what each reader may learn CONFIDENTIALITY: a party's export does not contain unissued or superseded AI drafts
- `06-evidence-storage-s3` — export bundle: contents, integrity and what each reader may learn CONFIDENTIALITY: a party's export does not list the counterparty's rejected (infected) uploads
- `06-evidence-storage-s3` — export bundle: contents, integrity and what each reader may learn CONFIDENTIALITY: a party's export timeline withholds the event types the live API withholds (NOTE_ADDED, RECOMMENDATION_DRAFTED)
- `06-evidence-storage-s3` — export bundle: contents, integrity and what each reader may learn AVAILABILITY: generating an export for a record with long unbroken text does not freeze the whole server
- `07-ai-and-concurrency` — redrafting and new versions a failed NEW VERSION request must not destroy the issued recommendation the parties are acting on
- `07-ai-and-concurrency` — lifecycle races: a guard checked before the write must still hold when the write happens submitting twice at once: one submission, one event, one notification
- `07-ai-and-concurrency` — lifecycle races: a guard checked before the write must still hold when the write happens two case managers claiming the same unclaimed case: exactly one becomes the manager
- `07-ai-and-concurrency` — lifecycle races: a guard checked before the write must still hold when the write happens closing intake twice at once: one transition
- `07-ai-and-concurrency` — lifecycle races: a guard checked before the write must still hold when the write happens a withdrawal that commits first cannot be undone by a request that was already past its checks (withdraw vs close-intake)
- `07-ai-and-concurrency` — lifecycle races: a guard checked before the write must still hold when the write happens a withdrawal cannot be undone by a request that submits a draft case (withdraw vs submit)
- `07-ai-and-concurrency` — lifecycle races: a guard checked before the write must still hold when the write happens both parties consenting at the same instant: both requests succeed and the case resolves (no 500, no lost 'both consented')
- `07-ai-and-concurrency` — lifecycle races: a guard checked before the write must still hold when the write happens one party submitting two positions at once gets distinct, ordered versions
- `07-ai-and-concurrency` — lifecycle races: a guard checked before the write must still hold when the write happens revoking consent while the case is being closed cannot leave a CLOSED case with a revoked consent (revoke vs close)
- `08-integrity` — intentional tamper fixtures (separate database: aequitas_audit_tamper_test) the append-only guarantee has gaps for the table owner: TRUNCATE, DISABLE TRIGGER and DROP TRIGGER are allowed (observation: the app role owns the table)
- `10-input-robustness` — U+0000 in text fields must be refused or cleaned, never a 500 every free-text field answers < 500 to U+0000 (and the answer is not a stack trace)
- `10-input-robustness` — U+0000 in text fields must be refused or cleaned, never a 500 lone surrogates are handled (stored with replacement or refused), never a 500
- `10-input-robustness` — length limits (the API states none for several fields) a long display name must not produce a challenge cookie that browsers discard (cookies over 4096 bytes are dropped)
