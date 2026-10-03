# Aequitas backend end-to-end audit: report

**Date:** 2026-10-03 · **Release under test:** `9c772f16e6eef79c0952188e8c05df92bbb5249a` (tracked files unchanged; the only additions are `audit/`, `test/audit/` and `vitest.audit.config.mts`) · **Runtime:** Node 22.22.0, npm 11.21.0, Next.js 16.3.8, `next build` + `next start` (production mode) · **Repository:** `martinlepage26-bit/aequitas`, checked out at `/home/user/aequitas` in this cloud container. The paths named in the brief under `/home/martin/Applications/` do not exist here, so `aequitas` and its 35 changed files were not touched.

## 1. Verdict

**The backend is not fully verified.** I drove the production-mode build over real HTTP with a real PostgreSQL, real object storage (MinIO and local disk), a real ClamAV daemon and a cryptographically valid software WebAuthn authenticator. The ordered full run executed 332 checks: 278 passed and 54 failed. I then added one regression test (the `verify:events` gap, F-22), which fails as designed. All 54 failures of the full run map to application behaviour, and they reduce to 24 distinct defects: 4 High, 8 Medium and 12 Low (section 4). Nothing in `src/` was changed. Each defect has a regression test in `test/audit/` that asserts the correct behaviour, so it is red today and should turn green when the fix lands.

Several checks could not be run because a dependency was unavailable, and they are marked NOT TESTED in section 6 with the exact missing dependency: production (egress to the Railway host is blocked), current ClamAV signatures (egress to the signature mirrors is blocked), the production storage backend, real Resend, real Anthropic, and real browser passkeys. Email and AI behaviour is mocked throughout. Until those are covered and the defects are fixed, the backend should not be described as verified.

Severity legend: **High** is a confidentiality breach between roles, or a core workflow that is unusable or silently wrong in realistic use. **Medium** is a correctness, integrity or availability defect with a plausible trigger. **Low** is an error-handling, hygiene or defence-in-depth gap. Every finding reproduced against `next build` + `next start`; I did not run dev mode, and nothing could be compared with Railway.

## 2. What was real and what was mocked

| Component | In this audit | Verified external integration? |
|---|---|---|
| Application | Real: `next build` + `next start` on loopback, `NODE_ENV=production` | n/a |
| PostgreSQL | Real PostgreSQL 16.14, dedicated cluster, three `*_test` databases (audit, tamper, repository suite), synthetic role. Every migration, reset and cleanup went through a guard that refuses any other target. | Real |
| Object store (S3 path) | Real MinIO RELEASE.2025-10-15T17-29-55Z built from the pinned upstream commit | Real S3-compatible server, not the production provider |
| Object store (local path) | Real local filesystem backend (`STORAGE_LOCAL_DIR`, the backend `DECISIONS.md` describes for Railway volumes) | Sandbox disk, not a Railway volume |
| Virus scanner | Real clamd 1.5.4 from the repository's digest-pinned image, signature DB 28087 (2026-08-09) | Real scanner, stale signatures |
| WebAuthn | Software authenticator (ES256, `none` attestation) driving the server's real `@simplewebauthn/server` verification | Not a browser or platform authenticator |
| Email (Resend) | **Mocked.** `mail.ts` hard-codes `https://api.resend.com`, so a preload rewrites that URL to a local stub and blocks every other outbound `fetch`. The block log is empty (0 bytes after the full run). | None |
| AI (Anthropic) | **Mocked.** Local stub behind `ANTHROPIC_BASE_URL`, no spend. | None |
| Production (Railway) | **Not reachable.** One unauthenticated `GET` of the health URL was refused by the sandbox gateway (`CONNECT` answered 403). Nothing else was sent. | None |

## 3. Scorecard

Every area contains at least one failing check, so each area-level result is FAIL; the sub-check column says what passed and what failed. Observation-only tests (those whose title starts with "observation") record behaviour and cannot fail; they are listed in section 5, not counted as passes here.

| Area | Result | Sub-checks |
|---|---|---|
| 1. Authentication | **FAIL** | PASS: real WebAuthn registration (second device, takeover refused, placeholder not claimable, replay refused), sign-in with valid and tampered assertions (signature, challenge, type, RP, origin, flags), replay with an incrementing counter, expired/malformed/NaN-expiry/wrong-secret/wrong-purpose tokens, challenge and invite tokens cannot become sessions, sign-in options identical for existing and unknown emails, locale-preserving redirects, cookie attributes (HttpOnly, Secure, SameSite=Strict, 7-day session, 5-minute challenge). FAIL: sign-out behind a TLS-terminating proxy (F-03), no server-side revocation and stale roles (F-11), replay with a counter-less authenticator (F-13), orphan session answers 500 (F-14). |
| 2. Invitations and email | **FAIL** | PASS: administrator-only issue/list/revoke, 72-hour single use, replacement revokes the older link, two simultaneous claims leave one winner, revocation mid-ceremony prevents the claim, expired and forged tokens refused, Resend request construction (From, Reply-To, recipient, locale subject, link on `APP_URL`, idempotency key), nothing sent unless `sendEmail` is true, 7 provider failure modes (HTTP 500, 429, 422 and 401, a reply without an id, a non-JSON reply, a dropped connection), 10-second provider timeout, outbox retains and retries with the same idempotency key, no case content in mail, not-configured mode reports honestly. FAIL: addresses are case-sensitive for named respondents (F-04), outbox head-of-line blocking (F-09), concurrent invitations (F-15). NOT TESTED: real Resend delivery, DNS, MX and Gmail forwarding (nothing was touched). |
| 3. Case workflows | **FAIL** | PASS: full lifecycle create to export with DB, event and notification checks after every step, decline then redraft, withdrawal from each of 7 states, rejected transitions from all 8 states change nothing, wrong-role actors refused. FAIL: repeated withdrawal (F-16), refused and repeated close leave export bundles (F-12), concurrent transitions (F-05, F-06). |
| 4. Authorization and confidentiality | **FAIL** | PASS: read matrix of 8 actors x 7 states x 6 endpoints, refused read indistinguishable from a read of a missing case, no storage keys, buckets or hashes in JSON, write matrix over 12 routes, anonymous 401 everywhere, AI draft visible only to the assigned reviewer, parties see only the issued recommendation, staff reads audited (one `ACCESS_STAFF_GRANTED` per administrator read, 30 concurrent reads give 30 gap-free events), no evidence download route exists. FAIL: export copies given to parties (F-01), unsubmitted cases visible to the respondent (F-02), existence oracles on write routes (F-17). |
| 5. Evidence and storage | **FAIL** | PASS (S3 and local): PNG, JPEG, PDF and text stored byte for byte under server-chosen keys with SHA-256 recorded and type taken from contents, invalid submissions refused with nothing stored, 7 of 8 hostile names inert, sizes up to 9 MiB, EICAR and EICAR-in-ZIP detected, rejected items hidden from the counterparty and the AI, scanner down fails closed, DB failure after write removes only the new object, event-append failure rolls back and cleans, intake closing mid-upload gives 409 and cleans, object store outage leaves no partial state and recovers, local disk fault leaves none, export-record failure removes the archive and leaves the case open, superseded objects kept, export archive hash, timeline re-verification and no storage keys. FAIL: uploads above about 10 MiB (F-07), export freezes the server (F-08), error text leaks (F-18), EICAR contract (F-19), NUL in names (F-20). |
| 6. AI drafting and concurrency | **FAIL** | PASS: 15 provider failure modes each leave the case recoverable with a `DRAFT_FAILED` event and a plain 502, code-fenced JSON accepted, one SDK retry on 5xx, two simultaneous draft requests call the provider once, late success and late failure of expired requests cannot overwrite a newer draft, 14-minute request protected and 16-minute request retryable, crash mid-draft recoverable, review vs issue and double issue resolve to one winner, prompt carries only clean evidence and no personal identifiers. FAIL: failed redraft discards the issued recommendation (F-10), lifecycle races (F-05), deadlocks (F-06). NOT TESTED: the provider timeout (the app sets none; the SDK default of about 10 minutes cannot be exercised in a run), real model. |
| 7. Integrity and HTTP | **FAIL** | PASS: independent re-verification of every hash chain (208 cases, 2,117 events, 0 broken), contiguous `seq`, canonical-JSON round trip, 40 simultaneous chronology writes and 36 mixed writes keep one valid chain, `verify:events` agrees on the valid DB, six classes of tampering detected in the separate tamper DB, UPDATE and DELETE refused by the append-only trigger, `/api/health` reports 503 in 9 ms when Postgres is down and recovers, 21 malformed percent-encoding probes answer 400 and never 5xx (6 valid encodings are handled without a 5xx), security headers on 7 response classes, CSP nonce fresh per request, no permissive CORS, bad JSON on 17 routes never 5xx, 405 for unsupported methods, oversized URL and header answer 431, source and config files not served, hostile `next=` values neutralised. FAIL: `verify:events` is blind to illegal transitions (F-22), the table owner can bypass append-only (F-23), documented alias route missing (F-24), U+0000 gives 500 (F-20). NOT TESTED: separating app behaviour from Railway edge behaviour. |
| Production (Railway) | **NOT TESTED** | Missing dependency: egress to `aequitas-production-5a0c.up.railway.app:443` (section 6). |

## 4. Findings

Convention for the reproductions: **C** is a synthetic complainant, **R** a respondent, **M** the assigned case manager, **A** an administrator, all created through the real invite and WebAuthn flows with addresses at `@audit.example.test`. "Test" names the regression test and its suite file under `test/audit/`; "Evidence" names the observation id in `evidence/observations/` or the exchange log in `evidence/http/`.

| ID | Severity | Workflow | Defect | Failing executions |
|---|---|---|---|---|
| F-01 | High | Close, export | A party's copy of the export contains staff-only and counterparty material | 10 |
| F-02 | High | Case read | A respondent can see a case the complainant has not submitted | 1 |
| F-03 | High (conditional) | Sign-out | Sign-out is refused behind a TLS-terminating proxy | 1 |
| F-04 | High | Create case, invite | Respondent addresses are case-sensitive, so the named respondent can be unable to see their case | 2 |
| F-05 | Medium | All transitions | Check-then-act races produce duplicate events, resurrected withdrawn cases and illegal sequences | 6 |
| F-06 | Medium | Consent, positions | Simultaneous writes deadlock and one request answers 500 | 2 |
| F-07 | Medium | Evidence upload | Files above about 10 MiB are refused with a misleading 400 although the limit is 25 MiB | 6 |
| F-08 | Medium | Close, export | Export generation blocks the event loop for 15 to 18 s on a 100,000-character text | 2 |
| F-09 | Medium | Notifications | 20 undeliverable notifications starve every later recipient | 1 |
| F-10 | Medium | Redraft | A failed redraft request discards the issued recommendation | 1 |
| F-11 | Medium | Sessions | Sessions cannot be revoked and role changes lag by up to 7 days | 2 |
| F-12 | Medium | Close | Refused or repeated close stores unrecorded export bundles | 2 |
| F-13 | Low | Sign-in | Passkey assertion replay works for counter-less authenticators | 1 |
| F-14 | Low | Sessions | A session for a missing user answers 500 on case creation | 1 |
| F-15 | Low | Invitations | Concurrent invitations for one new address give one 500 | 1 |
| F-16 | Low | Withdraw | Repeated withdrawal appends a second event and notification | 1 |
| F-17 | Low | Consent, issue | Real and made-up ids are told apart by message | 2 |
| F-18 | Low | Close | ORM and storage error text is echoed to clients | 3 |
| F-19 | Low | Evidence upload | An infected upload answers 200 and the bytes are persisted | 2 |
| F-20 | Low | All text inputs | U+0000 and lone surrogates give 500 | 4 |
| F-21 | Low | Registration and text inputs | No length limits; a long name creates a cookie browsers drop | 1 |
| F-22 | Low | Verification | `verify:events` accepts a hash-valid log with an illegal transition | 0 in the full run, 1 afterwards |
| F-23 | Low | Event log | The table owner can bypass the append-only trigger | 1 |
| F-24 | Low | API docs | The documented `POST /api/cases/:id/recommendation` alias does not exist | 1 |

### F-01 · High · A party's copy of the export contains staff-only and counterparty material

**Reproduction.** Drive one case through the whole lifecycle: R uploads the EICAR file as evidence (title `RESP-REJECTED-MARKER`, rejected by the scanner), M requests an AI draft and edits it with `PATCH /api/cases/{id}/draft` giving the reason `PRIVATE-REVIEW-NOTE-MARKER` (the edit supersedes the first draft and records the note), M issues the result, both parties consent, A reads the case once, and M calls `POST /api/cases/{id}/close`. C then calls `GET /api/cases/{id}/export`, unzips `case-record.json` and reads the PDF text.

**Expected and observed.** HTTP 200 with a byte-identical archive for C, R and M (a passing test asserts the identical SHA-256). Expected: nothing the live API withholds from a party. Observed in the party's copy: the e-mail addresses of the counterparty and the reviewer (the workspace never shows e-mail), the private reviewer note, the superseded recommendation (status `SUPERSEDED`), the counterparty's rejected upload, and the event types `NOTE_ADDED` and `RECOMMENDATION_DRAFTED`, which the party's live timeline never shows.

**Cause.** `src/domain/exportBundle.ts` (lines 77 to 113) selects every row, including `email`, into one record, and `src/app/api/cases/[caseId]/export/route.ts` serves the single stored archive to any party once the case is `CLOSED`.

**Proposed fix.** Build the party copy from the same projection functions the live API uses: issued recommendation only, no `email` fields, counterparty evidence filtered by scan status and submitter, staff-only event types removed. Keep the full sealed archive for the assigned manager and administrator. Removing events breaks the published chain formula for the party copy, so either keep `{seq, hash, prevHash}` for withheld events (linkage remains checkable) or seal two archives with separately recorded hashes. This needs a product decision.

**Tests.** `06-evidence-storage-export`, five "CONFIDENTIALITY" tests, run on S3 and local storage (10 failing executions). Evidence: observations `export-emails`, `export-recommendations`, `export-staff-events`.

### F-02 · High · A respondent can see a case the complainant has not submitted

**Reproduction.** C calls `POST /api/cases` naming an existing respondent R and does not call `/submit`. R signs in and requests `GET /fr-CA/cases`, `GET /api/cases/{id}` and `GET /fr-CA/cases/{id}`.

**Expected and observed.** Expected 404 and no list row, because C has not chosen to disclose anything. Observed: the list shows the reference number, the API answers 200 with `referenceNumber`, `category`, `state: DRAFT` and the complainant's display name, and the page renders 200. The access matrix, which encodes the implemented rule, also records 200 for R on `/events` and `/chronology` of the draft case. No `CASE_SUBMITTED` event and no notification exist at that point.

**Cause.** `src/domain/caseAccess.ts` line 24 returns `"party"` for the respondent in every state, and the respondent branch of `src/app/[locale]/cases/page.tsx` (line 31) lists every state. The access comment does not say whether drafts are private, so the severity assumes the brief's "draft privacy" applies to unsubmitted cases; the AI-draft part of draft privacy passes.

**Proposed fix.** In `caseReadAccess`, return `null` for the respondent while `state === "DRAFT"`, and add `state: { not: "DRAFT" }` to the respondent list query. Decide how a case withdrawn before submission should read for the respondent.

**Test.** `05-authorization`, "a respondent cannot see a case the complainant has not submitted yet". Evidence: observation `respondent-sees-draft-case`.

### F-03 · High (conditional) · Sign-out is refused behind a TLS-terminating proxy

**Reproduction.** A signed-in C posts the sign-out form with the headers a browser at the public site and a proxy would produce: `Host: aequitas-audit.example.test`, `Origin: https://aequitas-audit.example.test`, `X-Forwarded-Proto: https`, `X-Forwarded-Host: aequitas-audit.example.test`, `Sec-Fetch-Site: same-origin`.

**Expected and observed.** Expected 303 to `/en-CA/auth/sign-in` with the session cookie cleared. Observed 403 `{"message":"Request not permitted."}` and the cookie is not cleared, so the user is not signed out. The same-origin case on plain loopback HTTP passes, which is why local and Playwright runs cannot see this.

**Cause.** `src/app/api/auth/sign-out/route.ts` line 8 compares `Origin` with `new URL(request.url).origin`. For `next start`, Next builds `request.url` from `x-forwarded-proto` plus the process's bound host and port (`node_modules/next/dist/server/next-server.js` line 1284) and never from `Host`, so the origin it compares can never equal the public one. `experimental.trustHostHeader` is not a fix: it is read only when hostname and port are absent.

**Production mode.** Reproduced in the production build with simulated proxy headers. Whether Railway is affected is NOT TESTED (egress blocked); any deployment whose public origin differs from `proto://bind-host:port` is.

**Proposed fix.** Compare `Origin` with the configured public origin (`ORIGIN` from `src/lib/webauthn.ts`, which must already be correct for passkeys to work), and keep the `Sec-Fetch-Site` check.

**Test.** `02-authentication`, "sign-out accepts a same-origin browser POST arriving through a TLS-terminating proxy". Evidence: observation `signout-behind-proxy`.

### F-04 · High · Respondent addresses are case-sensitive, so the named respondent can be unable to see their case

**Reproduction (a).** R is a registered respondent at `name@audit.example.test`. C calls `POST /api/cases` with `respondentEmail: "Name@Audit.Example.test"` and a display name. **(b).** C names a new respondent as `Mixedcase.x@Audit.example.test`. A invites that address (the invite route lowercases it) and the invitee claims the link and signs in.

**Expected and observed.** Expected one mailbox, one account, and the case visible to the named person. Observed (a): HTTP 200, the case points at a new placeholder user that is not R, two `User` rows exist for one mailbox, and `GET /api/cases/{id}` as R answers 404. Observed (b): the invite without a display name answers 400, with one it creates a second `User` row, and the invitee's `GET /api/cases/{id}` answers 404. The case never becomes visible to the person it names, and nobody is told.

**Cause.** `src/app/api/cases/route.ts` (lines 43, 56, 58) uses `body.respondentEmail` without trim or lowercase in `findUnique`, `upsert` and `create`, while registration, invitation and sign-in normalise. The unique index on `User.email` is case-sensitive.

**Proposed fix.** Normalise in the case route with a shared helper, enforce lowercase in the database (a `CHECK (email = lower(email))` or a unique index on `lower(email)`), and ship a data migration that finds case-insensitive duplicates and repoints cases to the credentialed account. Run a read-only duplicate query against production first.

**Tests.** `03-invitations-email`, "naming an EXISTING respondent with different letter case…" and "a placeholder typed with capital letters…". Evidence: observations `existing-respondent-different-case`, `mixed-case-placeholder`.

### F-05 · Medium · Check-then-act races produce duplicate events, resurrected withdrawn cases and illegal sequences

**Reproduction.** For each pair, hold `SELECT … FOR UPDATE` on the case row from a separate database session, send both requests so that both pass their pre-checks, then release the lock. (a) C `POST /submit` twice. (b) Two managers `POST /open-intake` on one OPEN case. (c) M `POST /close-intake` twice. (d) C `POST /withdraw` with M `POST /close-intake` on an `EVIDENCE_INTAKE` case. (e) C `POST /withdraw` with C `POST /submit` on a DRAFT case. (f) M `POST /close` while R `POST /consent {action: "revoke"}`; here a trigger makes the `EXPORT_GENERATED` insert take 3 s instead of a lock.

**Expected and observed.** Expected one winner and a 409 or 404 for the other, with a legal event sequence. Observed, every pair answers 200 and 200. (a) Two `CASE_SUBMITTED` events. (b) Both managers are told they own the case, the second one holds it, two `CoiDeclaration` rows and two `EVIDENCE_INTAKE_OPENED` events exist. (c) Two `EVIDENCE_INTAKE_CLOSED` events. (d) Final state `POSITIONS` after `CASE_WITHDRAWN`: the withdrawn case is resurrected. (e) Final state `OPEN` after `CASE_WITHDRAWN`. (f) The case ends `ISSUED` with `closedAt` set and one revoked consent, after an export was sealed for the earlier state; the log reads `CASE_CLOSED`, `CONSENT_REVOKED`, `CASE_REOPENED`, both illegal from `CLOSED`. Hash chains stay valid in all of them, and the repository's `verify:events` accepts them (F-22). After the full run, 6 cases in the valid database carried such sequences (observation `legality-all-cases`).

**Likelihood.** The barrier forces the interleaving; I did not measure how often it occurs naturally. The window is the gap between the pre-check and the write transaction, and (a) and (c) are double-click shapes.

**Cause.** `src/domain/mutate.ts` evaluates guards on a row read before the write transaction and then writes with an unconditioned `tx.case.update` (lines 278, 314, 601, 1040, 1102, 1156, 1210, 1251 and 1288). Only the evidence, chronology and draft paths use compare-and-set. `appendEvent` serialises event writes with `FOR UPDATE` (`src/domain/events.ts` line 56), but only after the state decision was made.

**Proposed fix.** In `runMutation`, open the transaction first, `SELECT … FOR UPDATE` the case row, re-read the state, re-run the transition guard against the locked row, and only then write. This removes the whole class and also fixes F-06.

**Tests.** `07-ai-and-concurrency`, six "lifecycle races" tests. Evidence: observations `double-submit`, `double-claim`, `double-close-intake`, `withdraw-vs-close-intake`, `withdraw-vs-submit`, `revoke-vs-close`.

### F-06 · Medium · Simultaneous writes deadlock and one request answers 500

**Reproduction.** On an ISSUED case, R and C each `POST /api/cases/{id}/consent {action: "give", statementVersionId}`, released together by the same barrier, repeated 8 times. Separately, C `POST /positions` twice at once.

**Expected and observed.** Expected two 200 responses and a resolved case. Observed: in 8 of 8 iterations one consent answered 200 and the other 500 with an empty body; one `ConsentRecord` was stored and the state stayed `ISSUED`, so the failed party has to retry. The double position answered 500 and 200. The Postgres log records 27 `deadlock detected` errors in the race suite; each pairs an `UPDATE "Case" SET "state"` in one transaction with the `SELECT … FOR UPDATE` that `appendEvent` issues in the other (24 and 30 participants, `evidence/observations/postgres-deadlocks.txt`).

**Proposed fix.** The F-05 fix (lock the case row first in every write transaction) removes the lock-order inversion. Retrying once on SQLSTATE 40P01 in `runMutation` is a cheap second layer.

**Tests.** `07-ai-and-concurrency`, "both parties consenting at the same instant…" and "one party submitting two positions at once…". Evidence: observations `simultaneous-consent`, `double-position`.

### F-07 · Medium · Files above about 10 MiB are refused with a misleading 400 although the limit is 25 MiB

**Reproduction.** With evidence intake open, C posts `multipart/form-data` to `POST /api/cases/{id}/evidence` with valid PNG-typed files of 9 MiB, 11 MiB, 24 MiB and exactly 25 MiB.

**Expected and observed.** The route's own limit is 25 MiB. 9 MiB: 200, stored byte for byte with a matching SHA-256. 11, 24 and 25 MiB: 400 `{"message":"Expected multipart/form-data."}` and nothing stored. 25 MiB + 1 byte also answers 400, for the wrong reason.

**Cause.** `src/proxy.ts` matches `/api/*`, so Next buffers and clones every request body up to `experimental.proxyClientMaxBodySize`, whose default is 10 MiB (`node_modules/next/dist/server/config-shared.js` line 279). Larger bodies are silently truncated, `formData()` then throws, and the route reports "Expected multipart/form-data". `next.config.mjs` does not set the option.

**Proposed fix.** Set `experimental.proxyClientMaxBodySize` to about `"27mb"` in `next.config.mjs` (25 MiB plus multipart overhead). Excluding the evidence route from the proxy matcher is the alternative, but it would also skip the malformed-URL guard on that route. Return 413 with a clear message for oversize files.

**Tests.** `06-evidence-storage-export`, the 11 MiB, 24 MiB and 25 MiB tests on both backends (6 executions). Evidence: observations `size-11534336`, `size-25165824`, `size-26214400`.

### F-08 · Medium · Export generation blocks the event loop for 15 to 18 s on a 100,000-character text

**Reproduction.** C posts a position of 100,000 characters without spaces (accepted, 200), R posts a short position, C withdraws, and M calls `POST /api/cases/{id}/close` while a client polls `GET /api/health` every 250 ms.

**Expected and observed.** Expected `/api/health` to answer within 3 s. Observed: close took 15.6 s on S3 and 17.8 s on local storage, and the health request in flight answered after 15.3 s and 17.6 s (only 2 probes completed during the export). A second record with ordinary prose (a 300,000-character position and 20 chronology entries of 8,000 characters) took 23.6 s and 25.6 s to close; I did not measure event-loop blocking in that run.

**Cause.** The PDF is built in the request thread (`src/domain/exportBundle.ts`, `wrapText` and the per-character `widthOfTextAtSize` calls for overlong words), and no input length is limited (F-21; a 9,000,000-character position was accepted). I did not profile it, and I measured only 100,000 characters, so how the cost grows beyond that is unknown.

**Impact.** A party can make the manager's close or an administrator's export stall every user of the instance. A platform health check could restart the process mid-export; that was not tested.

**Proposed fix.** Cap field lengths at the API, build the PDF off the main thread (worker or child process), and avoid the per-character width loop for long tokens.

**Tests.** `06-evidence-storage-export`, "AVAILABILITY: generating an export for a record with long unbroken text…" on both backends. Evidence: observation `export-event-loop-blocking`.

### F-09 · Medium · Twenty undeliverable notifications starve every later recipient

**Reproduction.** In the audit database, insert 21 unsent `Notification` rows for an account whose address the mocked provider rejects (HTTP 422), then one row for a healthy account. A calls `PATCH /api/auth/invite` (the retry) three times.

**Expected and observed.** Expected the healthy recipient to be delivered. Observed: 60 provider calls, all to the failing address (20 per pass), 0 to the healthy one, so it is never delivered. I inserted the rows directly, because generating 21 failing notifications through case events would take many events.

**Cause.** `src/lib/mail.ts` `deliverPendingNotifications` takes the 20 oldest rows with `sentAt: null` (`take: 20`, ordered by `createdAt`) and keeps no attempt count, back-off or failure state, so the oldest undeliverable rows monopolise every pass.

**Proposed fix.** Add `lastAttemptAt` (or `nextAttemptAt` and `attempts`) to `Notification`, order by `lastAttemptAt` nulls first, set it on every failure, cap the attempts and surface the failed count to administrators.

**Test.** `03-invitations-email`, "one permanently failing recipient must not block every other recipient's notifications". Evidence: observation `outbox-starvation`.

### F-10 · Medium · A failed redraft request discards the issued recommendation

**Reproduction.** Take a case in `ISSUED` with version 1 issued. M calls `POST /api/cases/{id}/draft-requests` (the new-version path) while the mocked provider answers HTTP 500 without recovering.

**Expected and observed.** Expected 502 and version 1 still issued and current. Observed 502, the case state is `POSITIONS`, version 1 is `SUPERSEDED` and `currentRecommendationId` is null. The data is recoverable (M can request a new draft from `POSITIONS`, and version 1 and its events remain), but the parties lose the recommendation they were acting on, and any consent in progress, during a provider outage.

**Cause.** `requestNewVersion` (`src/domain/mutate.ts` lines 1181 to 1228) supersedes version 1 and moves the case to `DRAFTING` before the AI call. The failure path of `completeDraft` returns the case to `POSITIONS` and does not restore the earlier state.

**Proposed fix.** On failure, restore version 1 to `ISSUED`, the case to `ISSUED` and `currentRecommendationId` to version 1, recording `RECOMMENDATION_DRAFT_FAILED` with `toState: ISSUED`. That needs a `DRAFTING` to `ISSUED` edge in the state machine. Alternatively supersede only when the replacement draft has been validated.

**Test.** `07-ai-and-concurrency`, "a failed NEW VERSION request must not destroy the issued recommendation…". Evidence: observation `failed-new-version`.

### F-11 · Medium · Sessions cannot be revoked and role changes lag by up to 7 days

**Reproduction (a).** C signs in and copies the session cookie, signs out (303, cookie cleared in that client), and a second client presents the copied cookie to `GET /api/cases/{uuid}`. **(b).** A (ADMIN) issues an invitation (200), the audit database sets A's `globalRole` to `COMPLAINANT`, and A repeats `POST /api/auth/invite` with the same cookie.

**Expected and observed.** Expected 401 for (a) and 403 for (b). Observed: (a) 404, meaning the copied cookie is still authenticated; (b) 200, meaning a demoted administrator keeps administrator rights.

**Cause.** The session is a stateless HMAC cookie carrying `userId` and `globalRole` for 7 days, and `requireSession()` (`src/lib/session.ts`) never re-reads the user. This is a documented design trade-off (`DECISIONS.md`, `signedCookie.ts`: no session table), so the test confirms a known limitation rather than a hidden bug.

**Proposed fix.** Add an integer `User.sessionEpoch` to the token and compare it on each request with one primary-key read (also checking that the user exists and the role matches), and bump it on role change, credential removal and "sign out everywhere".

**Tests.** `02-authentication`, "a copied session cookie stops working after sign-out" and "a changed global role takes effect immediately". Evidence: observations `session-after-signout`, `role-change-takes-effect`.

### F-12 · Medium · Refused or repeated close stores unrecorded export bundles

**Reproduction.** M calls `POST /api/cases/{id}/close` on a case in `EVIDENCE_INTAKE`, and again on an already `CLOSED` case.

**Expected and observed.** Expected refusal without side effects. Observed 409 both times, but each call generated and stored an archive: one `ExportBundle` row and one object per call, with no event recording it (observations `refused-close-side-effect`, `reclose-side-effect`). The archives hold the full case record, including the content of F-01.

**Cause.** `src/app/api/cases/[caseId]/close/route.ts` calls `generateExportBundle` before `closeCase` evaluates the state guard, and never removes the archive when the guard refuses.

**Proposed fix.** Check the closable-state precondition first, and delete the archive and row if `closeCase` fails.

**Tests.** `04-case-workflows`, "a refused close … generates no export bundle row or object" and "closing an already closed case does not generate and store another export bundle".

### F-13 · Low · Passkey assertion replay works for counter-less authenticators

**Reproduction.** Register a software passkey whose signature counter stays 0 (as many synced passkeys report), request sign-in options, capture the challenge cookie, submit one valid assertion (200, session issued), then replay the same assertion body with the same challenge cookie from a second client.

**Expected and observed.** Expected 400. Observed 200 and a second session. The incrementing-counter replay is refused (passes). A failed attempt does not consume the challenge either (observation `challenge-survives-failed-attempt`).

**Cause.** The challenge is a stateless 5-minute cookie that is never marked used, so only the counter can stop a replay. Exploiting it needs the assertion body and the HttpOnly challenge cookie within 5 minutes, hence Low.

**Proposed fix.** Record the hash of each consumed challenge until its expiry (a small table or cache) and refuse reuse.

**Test.** `02-authentication`, "REPLAY, counter-less authenticator…". Evidence: observation `replay-counterless-signin`.

### F-14 · Low · A session for a missing user answers 500 on case creation

**Reproduction.** Present a correctly signed session cookie for a random user id that does not exist (the harness signs it with the audit secret, standing in for a user deleted while a cookie is still valid), then call `GET /api/cases/{uuid}` and `POST /api/cases`.

**Expected and observed.** Expected 401 or 404 from both. Observed 404 from the read and 500 from `POST /api/cases`.

**Cause.** `src/app/api/cases/route.ts` loads the signed-in user with `findUniqueOrThrow`. The F-11 fix (checking the user on each request) also removes this.

**Test.** `02-authentication`, "observation: a correctly signed session for a user that does not exist" (it fails on the 500). Evidence: observation `orphan-session`.

### F-15 · Low · Concurrent invitations for one new address give one 500

**Reproduction.** A sends two identical `POST /api/auth/invite` requests at once for a new address.

**Expected and observed.** Expected two responses below 500 and one `User` row. Observed 200 and 500 (the loser hits the unique index on `User.email` unhandled).

**Proposed fix.** Catch the unique-violation (Prisma `P2002`) and re-read, or use `upsert`.

**Test.** `03-invitations-email`, "concurrent invitations for the same new address do not 500". Evidence: observation `concurrent-invite-same-email`.

### F-16 · Low · Repeated withdrawal appends a second event and notification

**Reproduction.** C calls `POST /api/cases/{id}/withdraw` twice.

**Expected and observed.** Expected 409, or 200 as a no-op. Observed 200 both times, a second `CASE_WITHDRAWN` event and a second notification to R (observation `double-withdraw`).

**Cause.** The `withdraw` source-state set is any state except `CLOSED`, so it includes `WITHDRAWN`; `withdrawCase` has no early return. **Proposed fix.** Exclude `WITHDRAWN` from the set or return early.

**Test.** `04-case-workflows`, "repeating a withdrawal is idempotent…".

### F-17 · Low · Real and made-up ids are told apart by message

**Reproduction.** A party of another case calls `POST /api/cases/{id}/consent` (give and decline) with a real case id and a random one; an unrelated manager calls `POST /api/recommendations/{id}/issue` with a real and a random recommendation id.

**Expected and observed.** Expected identical answers. Observed for consent: a real id gives 404 "Case not found." and a missing id gives 404 "No issued recommendation exists for this case."; without `statementVersionId` a real id gives 400 and a missing id gives 404. For issue: real 404 "Case not found." against missing 404 "Recommendation not found.". The ids are UUIDs, so the oracle is weak, which is why this is Low.

**Proposed fix.** Authorise first, return one message, and validate the body only afterwards.

**Tests.** `05-authorization`, "an outsider gets the same answer for a real case id and a non-existent one on every mutation route" and "issuing: an unrelated manager cannot tell…". Evidence: observations `write-denial-oracles`, `issue-denial`.

### F-18 · Low · ORM and storage error text is echoed to clients

**Reproduction.** (a) With a trigger that makes the `ExportBundle` insert fail, M calls `POST /api/cases/{id}/close`. (b) With MinIO stopped, M calls `POST /api/cases/{id}/close`.

**Expected and observed.** The cleanup is correct in both: the archive is removed, no row or event is left, the case stays open and closes normally once the fault is gone (verified on both backends after reordering the test so the leak check cannot hide the recovery check). The 502 body, however, carries internals: (a) "Invalid `prisma.exportBundle.create()` invocation … Database error. Code: `P0001`", (b) "connect ECONNREFUSED 127.0.0.1:9010".

**Cause.** `src/app/api/cases/[caseId]/close/route.ts` returns `error.message`. **Proposed fix.** Log it server-side and return a fixed message.

**Tests.** `06-evidence-storage-export`, "export-record failure…" (both backends) and "object store unavailable (MinIO stopped)…" (S3). Evidence: observations `export-record-failure`, `minio-down`.

### F-19 · Low · An infected upload answers 200 and the bytes are persisted

**Reproduction.** R uploads the EICAR test string as evidence while intake is open.

**Expected and observed.** HTTP 200 `{"caseId","state"}` with no scan result. The row is `REJECTED`, one object is stored under a server-chosen key, an `EVIDENCE_SUBMITTED` event records `scanStatus: REJECTED`, and one `evidence_rejected` notification is queued for the uploader. The item is hidden from the counterparty and the AI and shown to the submitter (those checks pass), and no download route exists, so the stored bytes are inert today. The code records the attempt on purpose; the open points are that an API client cannot tell the file was refused and that infected content is kept.

**Proposed fix.** Return `422` with the evidence id and `scanStatus` for a rejected file, and store infected content only under a quarantine prefix with an expiry, or keep just its hash.

**Test.** `06-evidence-storage-export`, "an EICAR upload is rejected…" (both backends; both facets now reported). Evidence: observation `eicar-upload`.

### F-20 · Low · U+0000 and lone surrogates give 500

**Reproduction.** Send `"a\u0000b"` in each of 13 fields: registration `displayName` and `email`, invitation `displayName` and `email`, case `respondentDisplayName` and `respondentEmail`, chronology `title` and `description`, position `body`, evidence `title` and `description`, close-intake `overrideReason`, open-intake `coiDetails`. Send a lone surrogate (U+D800) in chronology `title` and `description`.

**Expected and observed.** Expected 400 or cleaned text. Observed HTTP 500 with an empty body for all 13 fields, and for both chronology fields with the surrogate. Nothing is stored. The storage-key assertions for the other seven hostile evidence names (traversal, backslash, absolute, percent-encoded, 300 characters, CJK) pass.

**Cause.** PostgreSQL text cannot hold U+0000 or invalid UTF-8, and nothing validates before Prisma. **Proposed fix.** Strip or reject both at the API boundary with a shared string validator.

**Tests.** `10-input-robustness` (two tests) and `06-evidence-storage-export`, "path-like names are inert…" (both backends, failing only on the NUL name). Evidence: observations `nul-*`.

### F-21 · Low · No length limits; a long name creates a cookie that browsers drop

**Reproduction.** `POST /api/auth/webauthn/register {step: "options"}` with `displayName` of 100, 1,000, 2,500, 3,200 and 6,000 characters.

**Expected and observed.** The challenge `Set-Cookie` grew to 598, 1,798, 3,798, 4,731 and 8,465 bytes while the status stayed 200. Browsers drop cookies above 4,096 bytes, so registration with a long name fails silently. Elsewhere nothing is limited: a 1 MB `respondentDisplayName` and 1 MB and 9 MB positions answered 200 (9,000,000 characters stored); 12 MB answered 400 only because of the F-07 proxy cap.

**Proposed fix.** Schema limits on every free-text field (for example name 200, position 20,000 characters) with 400 or 413 answers.

**Test.** `10-input-robustness`, "a long display name must not produce a challenge cookie that browsers discard". Evidence: observations `challenge-cookie-size`, `length-limits`.

### F-22 · Low · `verify:events` accepts a hash-valid log with an illegal transition

**Reproduction.** Create a DRAFT case; C sends `POST /withdraw` and `POST /submit` held at the barrier; both answer 200. The log is `CASE_CREATED`, `CASE_WITHDRAWN`, `CASE_SUBMITTED` with a valid chain (independent verifier: 0 chain issues; legality: "CASE_SUBMITTED is not legal from WITHDRAWN"). Copy the case to the tamper database and run `npm run verify:events` there.

**Expected and observed.** Expected a non-zero exit. Observed "Checked 1 case(s). verify:events OK", exit 0. The documented job (hash chain plus projection) is met; the gap is that it cannot see sequences the state machine forbids, so it cannot detect damage already done by F-05.

**Cause.** `replayCaseState` (`src/domain/replay.ts`) applies each event's target state without checking the transition table, and `verifyCase` compares only the final state.

**Proposed fix.** Have `verifyCase` check each event against `stateMachine.ts` and report illegal transitions, then run it read-only against production once to find historic cases.

**Test.** `08-integrity`, "verify:events flags a hash-valid log that contains a transition the state machine forbids". It was added after the full run and executed alone (`evidence/reruns/08-verify-events-gap.json`): it fails as designed. Evidence: observations `verify-events-illegal-sequence-fixture`, `verify-events-illegal-sequence-verdict`.

### F-23 · Low · The table owner can bypass the append-only trigger

**Reproduction.** In the tamper database, connected as the application's role (which owns the table), run `TRUNCATE "Event"`, `ALTER TABLE "Event" DISABLE TRIGGER events_append_only` and `DROP TRIGGER events_append_only ON "Event"`, each inside a rolled-back transaction.

**Expected and observed.** All three succeed. `UPDATE` and `DELETE` are refused by the trigger (that test passes). The hash formula is published in every export's `verification.txt` and is unkeyed SHA-256, so anyone with owner rights can rewrite a log and recompute a consistent chain.

**Proposed fix.** Run migrations as a separate owner role and give the runtime role `INSERT` and `SELECT` on `"Event"` only, and anchor the latest chain head of each case outside the database. Which role production uses is NOT TESTED.

**Test.** `08-integrity`, "the append-only guarantee has gaps for the table owner…". Evidence: observation `append-only-bypass`.

### F-24 · Low · The documented `POST /api/cases/:id/recommendation` alias does not exist

**Reproduction.** `docs/aequitas-core-backend.md` lines 85 to 87 describe it as a compatibility alias of `draft-requests`. Call it as M on an eligible case.

**Expected and observed.** Expected the draft workflow; observed 404 from Next's route-not-found (no `recommendation` directory exists under `src/app/api/cases/[caseId]/`). **Proposed fix.** Add the alias or remove the sentence.

**Test.** `01-http-production`, "the documented POST /api/cases/:id/recommendation alias exists". Evidence: observation `documented-alias-recommendation`.

## 5. Observations that did not fail a test

These are recorded because they matter, not because they are defects. The observation-only tests pass by construction.

| ID | Observation | Evidence |
|---|---|---|
| O-1 | No rate limiting on sign-in: 30 consecutive failed attempts all answered 400. An edge in front of the app might add some; unknown. | `no-rate-limit-signin` |
| O-2 | Registration options disclose whether an address has an account (403 existing, 200 new), while sign-in options are structurally identical for existing and unknown addresses (that check passes). | `registration-enumeration`, `signin-options-shape` |
| O-3 | The IP hash stored with a consent record derives from the client-supplied `X-Forwarded-For` (the stored hash equals the hash of the header the test sent). It is forgeable unless the edge overwrites the header; not checked on Railway. | `consent-ip-from-forwarded-header` |
| O-4 | No content-type allow-list: an executable, an HTML file and an SVG with a script were accepted and scanned CLEAN (stored types `application/x-msdownload` and `text/plain`). Harmless while no download route exists and exports hold no file bytes. | `no-content-type-allowlist` |
| O-5 | Notification delivery runs inline: a 3-second provider delay delayed the submit response by 3.03 s, and a hanging provider can delay an action by up to the 10-second timeout. | `notification-latency-coupling` |
| O-6 | `405` responses carry no `Allow` header. | `405-allow-header` |
| O-7 | A signed-in user who opens the sign-in page is not redirected away (200). | `signed-in-visits-signin` |
| O-8 | The export snapshot is taken before the close: the sealed record shows `RESOLVED_CONSENT`, `closedAt: null` and 20 timeline events against 22 live. | `export-snapshot-state` |
| O-9 | Every provider failure (including HTTP 401, 429, 500, 529 and dropped connections) reaches the user as a 502 prefixed "Explanation record failed schema validation:" with the hint "Check the configured model and account access". | `failure-*` |
| O-10 | In the export PDF, the reference number and a marker text are present, but CJK and Arabic input did not appear in the extracted text (the JSON keeps them). French and English are unaffected. | `pdf-unicode` |
| O-11 | The `%252`-style malformed-URL class answers 400 from the app in production mode (the earlier regression), while valid encodings such as `%252e%252e` are handled without a 5xx. | `malformed-percent`, `wellformed-percent` |

## 6. NOT TESTED, and what blocked it

None of the 54 failures is an environment blocker. The items below could not be run at all; each names the exact dependency that was missing.

| Item | Status | Missing dependency and consequence |
|---|---|---|
| Production (Railway) public health, headers, redirects, unauthenticated requests | NOT TESTED | Network egress to `aequitas-production-5a0c.up.railway.app:443`. The one unauthenticated `GET` of the health URL was refused by the sandbox gateway (`CONNECT` answered 403; record in `evidence/production/production-reachability.txt`). Edge-dependent behaviour (TLS termination, `X-Forwarded-*`, size and header limits, health checks, restarts) is unverified, so app failures cannot be separated from Railway edge behaviour. F-03 and O-3 stay conditional. |
| Real Resend | NOT TESTED | A Resend API key, a verified sending domain, a mailbox I am allowed to mail, and egress to `api.resend.com`; none supplied, and the brief ruled out real mail. Only the request the app builds and its reaction to stubbed responses were verified. DNS, MX records and Gmail forwarding were not touched. Whether Resend dedupes on `Idempotency-Key` is provider behaviour and was not tested. |
| Real Anthropic | NOT TESTED | `ANTHROPIC_API_KEY` and egress to `api.anthropic.com`; the brief ruled out paid calls. The client sets `maxRetries: 1` and no timeout (`src/ai/draftRecommendation.ts`), so the SDK default of about 10 minutes applies and was not exercised; hangs were simulated with held and dropped connections. |
| Current ClamAV signatures | NOT TESTED | Egress to the ClamAV signature mirrors for `freshclam`. The real clamd ran with the baked-in signature set (DB 28087, 2026-08-09, about eight weeks old). Detection was verified for the EICAR file and EICAR inside a ZIP only; no other malware sample was used. The production scanner's version and signature age are unknown. |
| Production storage backend | NOT TESTED | The production bucket endpoint and credentials, or a Railway volume. S3 behaviour came from MinIO and local behaviour from the sandbox disk, so provider IAM, versioning and lifecycle rules, server-side encryption, volume permissions and capacity are unverified. |
| Browser passkeys | NOT TESTED | A browser with a virtual or platform authenticator on a real HTTPS origin. The software authenticator covers server-side verification, not browser UI, user-verification prompts, discoverable credentials or cross-device flows. The audit ran with a placeholder relying-party ID and origin, not the production values. |
| Production database role and privileges | NOT TESTED | Read access to production, which was out of scope. It decides how serious F-23 is. |
| Edge rate limiting | NOT TESTED | Unknown without production access; the app itself has none (O-1). |
| Repository Playwright suite (`npm run test:e2e`) | NOT RUN | UI layer, outside the backend brief. `ensure:storage-bucket` and `smoke:core-ai` were not run either. |

## 7. Baseline checks and the repository's own suite

| Check | Result |
|---|---|
| `npm run lint` | exit 0 |
| `npm run typecheck` | exit 0 |
| `npm run check:i18n-parity` | OK, 446 keys match across `fr-CA` and `en-CA` |
| `npm run check:forbidden-terms` | exit 0 |
| `npm run build` | Next.js 16.3.8 (Turbopack) compiled successfully |
| Repository suite (`vitest run`, from a separate worktree at the same commit, own database) | 32 files, 629 tests, all passed |
| `verify:events` before the suite | OK, 0 cases |
| `verify:events` after the repository suite | Exit 1, 2 issues, both from the suite's own fixtures: case reference prefixes `AE-TAMPER-BAD-` (an intentional tamper fixture) and `AE-CHRONOLOGY-TEST-` (a stored state that differs from the replay). Both prefixes occur in `test/integration/verify-events-tamper.test.ts` and `test/integration/chronology.test.ts`; I did not read those tests beyond finding the prefixes. This is why the audit keeps its tamper fixtures in a separate database. |
| `verify:events` on the audit database after the full run | OK, exit 0 (208 cases, 2,117 events, independent verifier: 0 broken chains, 6 cases with race-produced illegal sequences) |

Audit suites, from the full ordered run (`evidence/summary.md`):

| Suite | Area | Tests | Passed | Failed |
|---|---|---:|---:|---:|
| 00-harness-smoke | rig check | 1 | 1 | 0 |
| 01-http-production | 7 (HTTP) | 84 | 83 | 1 |
| 02-authentication | 1 | 32 | 27 | 5 |
| 03-invitations-email | 2 | 31 | 27 | 4 |
| 04-case-workflows | 3 | 23 | 20 | 3 |
| 05-authorization | 4 | 33 | 30 | 3 |
| 06-evidence-storage (local) | 5 | 38 | 26 | 12 |
| 06-evidence-storage (S3) | 5 | 38 | 25 | 13 |
| 07-ai-and-concurrency | 6 | 34 | 25 | 9 |
| 08-integrity | 7 (integrity) | 11 | 10 | 1 |
| 10-input-robustness | 7 (HTTP) | 4 | 1 | 3 |
| 11-mail-not-configured | 2 | 3 | 3 | 0 |
| **Total** | | **332** | **278** | **54** |

After the full run I added the F-22 regression test (executed alone, fails), reordered two tests so that one failing assertion can no longer hide later checks (path-like names; export-record failure) and split a third into soft and hard assertions (EICAR), and re-ran those three alone on both backends (`evidence/reruns/`). Outcomes: the storage-key checks for path-like names pass and only the NUL name answers 500; the export-record failure test passes its cleanup and recovery checks and fails only on the leaked error text; the EICAR test now reports both the 200 response and the persisted object. The summary table above was not regenerated and does not include the reruns.

## 8. Harness notes: slips found and corrected during the audit

These were mistakes in my tests, fixed before the full run, and none of them is an application defect. The hostile `next=` check had flagged Next's own router-state payload and now inspects the sanitised `returnTo`. A null check on `Set-Cookie` tripped over the benign `NEXT_LOCALE` cookie. EICAR padded into a larger file is not a ClamAV detection (the signature is a whole-file hash), so only the ZIP-wrapped case counts and the test records both. Keep-alive connections went stale after blocking calls, so the harness uses asynchronous `execFile` and `Connection: close`. Poison notifications from one test wedged later ones, so each test now flushes the outbox, guarded by the database-target check. F-04 was found by accident when synthetic addresses with capital letters behaved differently; synthetic addresses are now lowercased and F-04 has its own tests. An earlier idea of fixing F-03 with `trustHostHeader` was dropped after reading Next's source.

## 9. Evidence layout and re-running

Evidence is sanitised: session cookies, signed tokens, secrets and API keys are replaced, and a scan found no secret value, signed token, cookie value or non-synthetic e-mail address anywhere under `audit/`, `test/audit/` or `vitest.audit.config.mts`. `evidence/results/` holds the vitest JSON per suite, `evidence/observations/` the named observations (and the deadlock excerpt), `evidence/http/` the redacted request and response logs, `evidence/baseline/` and `evidence/existing-suite/` the checks of section 7, `evidence/production/` the reachability record, and `evidence/reruns/` the post-run single-test executions. `README.md` describes the rig and how to rebuild it; the harness scripts contain sandbox paths that need adjusting elsewhere. Run a single suite with `harness/run-suite.sh <s3|local> test/audit/<file>.audit.ts`; the audit suites are not part of `npm test`.
