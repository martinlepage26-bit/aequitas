# AEQUITAS — Implementation Handoff
**For:** Claude (implementation agent)
**From:** Product owner (PHAROS AI Governance)
**Date:** 2026-08-14
**Status:** Approved for build

---

## 0. How to use this document

Build this app milestone by milestone (Section 19). Do not skip ahead: each milestone has acceptance criteria that must pass before starting the next. Where this document conflicts with a library default, this document wins. Where it is silent, choose the boring, well-documented option and note the choice in the project README's decision log (`DECISIONS.md`).

If anything in Sections 2, 6, 7, or 9 seems impossible or contradictory, STOP and ask the product owner before improvising. Those sections encode legal and ethical invariants, not preferences.

---

## 1. Product summary

Aequitas is a documented, human-reviewable dispute-resolution platform. Three roles share one case workspace through role-appropriate views:

- **Consumer** — files the dispute, submits evidence and a position, gives or withholds consent.
- **Retailer case handler** — responds with evidence and a position, gives or withholds consent.
- **Neutral case manager** — shepherds the case, requests an AI-drafted recommendation, reviews it, and is the only actor who can *issue* it.

Success means: a proposed outcome is always clearly distinguished from a decision; every material step is attributable to an actor and a timestamp; no party is ever represented as having consented before it has done so.

**Brand personality:** calm, exacting, impartial. Confidence through clarity and restraint. No legal or algorithmic overclaiming.

**Anti-references (never build these):** automated-justice theatre, opaque AI scoring, dashboard vanity metrics, pre-selected consent, generic fintech/SaaS decoration.

**Design principles:**
1. Consent is an explicit, reversible state.
2. Recommendations explain their evidence, limits, and reviewer.
3. Every role sees its authority and next action.
4. Compliance is evidenced, not asserted.
5. Simulated data can teach the workflow but must never impersonate live evidence.

---

## 2. Non-negotiable guardrails

These override everything else, including convenience:

1. **No mutation without an event.** Every state change, submission, consent action, issuance, and administrative act appends to the append-only event log (Section 8) inside the same database transaction as the domain write.
2. **The event log is append-only.** Enforce at the database level with a trigger that raises on UPDATE/DELETE of the `events` table. No application code path may attempt it.
3. **Consent is never pre-selected, pre-checked, or defaulted.** Its initial state is `NOT_GIVEN` and only an explicit, authenticated action by the party changes it.
4. **No AI output reaches a party without human issuance.** AI drafts; a named neutral case manager issues. There is no auto-publish path, no "auto-approve after N days," no exception.
5. **No numeric scores anywhere.** Not in the UI, not in the API, not in the database, not in logs. Any quantified allocation in a recommendation must be expressed in prose, traced to cited evidence.
6. **Terminology is law.** The system says "proposed outcome" / "résultat proposé", never "decision" / "décision" for AI-drafted or issued recommendations. Enforce via the i18n glossary (Section 12) and a CI lint that fails on forbidden terms in user-facing strings.
7. **Simulated and live data never mix.** Simulated cases, evidence, and parties are flagged at creation, stored under a distinct storage prefix, rendered with a persistent non-color-only banner, and cannot be cited by or migrated into a live case.
8. **French is co-equal, not a translation.** Every user-facing string, email, and generated document ships in French and English in the same release. A feature without both locales is unfinished.
9. **WCAG 2.2 AA is a release gate.** The axe-core CI suite must pass with zero violations on every core flow, in both locales (Section 13).
10. **Least-privilege by default.** Every endpoint checks role + case assignment. There is no "admin sees everything" shortcut in v1; platform staff access is itself an audited event.

---

## 3. Tech stack

Opinionated defaults. Substitute only with a logged decision.

| Layer | Choice | Why |
|---|---|---|
| Framework | Next.js 15 (App Router), TypeScript `strict` | One codebase for SSR UI + API; strong a11y ecosystem |
| Database | PostgreSQL 16 | Row-level integrity, transactional event appends, JSONB for payloads |
| ORM | Prisma | Typed schema, migrations Claude can generate reliably |
| Auth | Passkeys/WebAuthn via SimpleWebAuthn + session cookies | Satisfies WCAG 3.3.8 (no cognitive-test login); strong identity binding for consent |
| AI | Anthropic Claude API (`@anthropic-ai/sdk`), model ID pinned via env var | Structured Outputs for schema-valid drafts |
| i18n | next-intl, locales `fr-CA` (default) and `en-CA` | Bill 96 parity; FR is default |
| Styling | Tailwind CSS + design tokens (Section 17) | Restraint is easier with a constrained token set |
| File storage | S3-compatible bucket, Canada region (`ca-central-1` or Quebec region) | Law 25 data-residency posture |
| Upload scanning | ClamAV sidecar (dev) / provider scanning (prod) | Evidence intake safety |
| Testing | Vitest (unit), Playwright (e2e), axe-core (a11y gate) | See Section 18 |
| Infra | Docker Compose for dev; documented single-container prod target | Keep deploy boring |
| Email | Transactional provider via env-configured adapter, bilingual templates | Notifications are legal moments |

Environment variables (document in `.env.example`): `DATABASE_URL`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `STORAGE_ENDPOINT`, `STORAGE_BUCKET`, `STORAGE_REGION`, `STORAGE_SIMULATED_PREFIX`, `APP_DEFAULT_LOCALE=fr-CA`, `APP_LOCALES=fr-CA,en-CA`, `EMAIL_FROM`, `HASH_CHAIN_GENESIS` (64 zeroes), `SESSION_SECRET`.

---

## 4. Architecture overview

```
[ Next.js UI (role-scoped projections) ]
        |  server actions / route handlers
[ Application layer: guards -> transactions -> events ]
        |
[ PostgreSQL: domain tables + append-only events (hash-chained) ]
        |
[ Projections: case state, timeline, consent status — rebuilt from events, cached in tables ]
[ Object storage: evidence binaries (live/ and simulated/ prefixes) ]
[ Claude API: draft generation only, output quarantined until issued ]
```

Key architectural rules:

- **The event log is the source of truth.** Domain tables are a materialized projection. A `verify` job can rebuild any case's current state by replaying its events and must match the projection; CI runs this on seeded data.
- **Guards live in one place.** `src/domain/guards.ts` implements every guard in the state machine table (Section 6) as a pure function returning `{ ok: true } | { ok: false, reason: string }`. Route handlers call guards; they never inline permission logic.
- **All mutations follow one pipeline:** authenticate -> authorize (role + case assignment) -> evaluate guard -> begin transaction -> write domain rows -> append event(s) -> update projection -> commit -> enqueue notifications. Implement as `src/domain/mutate.ts` so no endpoint can accidentally skip a step.
- **AI output is quarantined.** Draft recommendations are written with status `DRAFT` and are invisible to consumer and retailer roles until a case manager issues them.

---

## 5. Domain model (Prisma schema target)

Enums: `CaseState`, `ConsentState`, `EvidenceKind`, `ScanStatus`, `RecommendationStatus`, `EventType`, `GlobalRole`.

```prisma
model User {
  id            String   @id @default(uuid())
  email         String   @unique
  displayName   String
  locale        String   @default("fr-CA")
  globalRole    GlobalRole            // CONSUMER | RETAILER_HANDLER | CASE_MANAGER | ADMIN
  createdAt     DateTime @default(now())
  credentials   WebAuthnCredential[]
}

model WebAuthnCredential {
  id           String @id @default(uuid())
  userId       String
  credentialId String @unique
  publicKey    Bytes
  counter      BigInt
  user         User   @relation(fields: [userId], references: [id])
}

model Case {
  id                    String   @id @default(uuid())
  referenceNumber       String   @unique   // human-readable, e.g. AE-2026-000123
  state                 CaseState
  simulated             Boolean  @default(false)  // immutable after creation
  consumerId            String
  retailerHandlerId     String
  caseManagerId         String?
  currentRecommendationId String?
  createdAt             DateTime @default(now())
  closedAt              DateTime?
}

model EvidenceItem {
  id          String   @id @default(uuid())
  caseId      String
  submittedById String
  kind        EvidenceKind          // DOCUMENT | PHOTO | MESSAGE | RECEIPT | OTHER
  title       String
  description String?
  storageKey  String   @unique      // prefix enforces live/ vs simulated/
  sha256      String
  byteSize    Int
  mimeType    String
  scanStatus  ScanStatus @default(PENDING)  // PENDING | CLEAN | REJECTED
  simulated   Boolean               // must equal parent case's flag; DB-checked
  version     Int      @default(1)
  supersedesId String?              // prior version kept, never deleted
  createdAt   DateTime @default(now())
}

model PositionStatement {
  id        String   @id @default(uuid())
  caseId    String
  partyId   String
  body      String
  locale    String
  version   Int      @default(1)
  createdAt DateTime @default(now())
}

model Recommendation {
  id           String   @id @default(uuid())
  caseId       String
  version      Int      @default(1)
  status       RecommendationStatus  // DRAFT | ISSUED | SUPERSEDED
  explanation  Json                   // schema in Section 9 — validated on write
  modelId      String
  promptVersion String
  issuedById   String?
  issuedAt     DateTime?
  createdAt    DateTime @default(now())
  @@unique([caseId, version])
}

model ConsentRecord {
  id                  String   @id @default(uuid())
  caseId              String
  recommendationId    String            // consent binds to a specific version
  partyId             String
  state               ConsentState      // NOT_GIVEN | GIVEN | DECLINED | REVOKED
  statementVersionId  String            // exact wording consented to (per locale)
  locale              String
  authContext         Json              // session id, auth method, hashed IP
  givenAt             DateTime?
  declinedAt          DateTime?
  revokedAt           DateTime?
  createdAt           DateTime @default(now())
}

model ConsentStatementVersion {
  id            String   @id @default(uuid())
  version       Int
  locale        String
  body          String
  effectiveFrom DateTime
  @@unique([version, locale])
}

model CoiDeclaration {
  id            String   @id @default(uuid())
  caseId        String
  caseManagerId String
  hasConflict   Boolean
  details       String?
  declaredAt    DateTime @default(now())
}

model Event {
  id        String   @id @default(uuid())
  caseId    String
  seq       Int
  type      EventType
  actorId   String                 // 'system' for automated steps
  payload   Json
  prevHash  String
  hash      String   @unique
  createdAt DateTime @default(now())
  @@unique([caseId, seq])
}

model ExportBundle {
  id            String   @id @default(uuid())
  caseId        String
  generatedById String
  storageKey    String   @unique
  sha256        String
  generatedAt   DateTime @default(now())
}

model Notification {
  id        String   @id @default(uuid())
  userId    String
  caseId    String
  kind      String
  locale    String
  sentAt    DateTime?
  createdAt DateTime @default(now())
}
```

Invariants enforced by DB constraints or transaction-time checks:
- `EvidenceItem.simulated` must equal its case's `simulated` flag.
- `Case.simulated` is immutable (no update path exists).
- `ConsentRecord.recommendationId` must equal the case's `currentRecommendationId` at write time.
- `Recommendation.status` transitions only `DRAFT -> ISSUED -> SUPERSEDED` or `DRAFT -> SUPERSEDED`.

---

## 6. Case state machine

Implement as a declarative transition table in `src/domain/stateMachine.ts`. The table below is the spec; the code must be generated from it (or tested exhaustively against it — see Section 18).

**States:** `DRAFT`, `OPEN`, `EVIDENCE_INTAKE`, `POSITIONS`, `DRAFTING`, `ISSUED`, `RESOLVED_CONSENT`, `RESOLVED_DECLINED`, `WITHDRAWN`, `CLOSED`.

Consent is tracked per party (Section 7), not as a case state; the case-level `RESOLVED_*` states are derived when consent outcomes complete.

| # | Trigger | From | To | Actor | Guards | Events emitted |
|---|---|---|---|---|---|---|
| 1 | create_case | — | DRAFT | consumer | authenticated; statement versions current | case.created |
| 2 | submit_case | DRAFT | OPEN | consumer (owner) | required intake fields complete | case.submitted, party.notified |
| 3 | open_intake | OPEN | EVIDENCE_INTAKE | case manager | case assigned to a case manager; COI declaration on file | evidence.intake_opened, coi.verified |
| 4 | submit_evidence | EVIDENCE_INTAKE | (same) | consumer or retailer handler | scanStatus=CLEAN before visible to others | evidence.submitted |
| 5 | supersede_evidence | EVIDENCE_INTAKE | (same) | submitting party | supersedes own prior item only | evidence.superseded |
| 6 | close_intake | EVIDENCE_INTAKE | POSITIONS | case manager | at least 1 evidence item per party, OR override with recorded reason | evidence.intake_closed |
| 7 | submit_position | POSITIONS | (same) | each party | one current version per party; edits create new version | position.submitted |
| 8 | request_draft | POSITIONS | DRAFTING | case manager | both parties have current positions; COI on file | recommendation.draft_requested |
| 9 | draft_completed | DRAFTING | (same) | system | Claude response validates against explanation schema | recommendation.drafted |
| 10 | issue_recommendation | DRAFTING | ISSUED | case manager | explanation record valid; all citations resolve to evidence in this case; reviewer = issuing manager | recommendation.issued, party.notified (both) |
| 11 | give_consent | ISSUED | ISSUED or RESOLVED_CONSENT | each party | consent binds to current recommendation version; statement version is current | consent.given; when both parties GIVEN: case.resolved |
| 12 | decline_consent | ISSUED | RESOLVED_DECLINED | either party | — | consent.declined, case.resolved_declined |
| 13 | revoke_consent | ISSUED, RESOLVED_CONSENT | ISSUED | consenting party | case not CLOSED | consent.revoked, case.reopened |
| 14 | request_new_version | RESOLVED_DECLINED, or ISSUED after revocation | DRAFTING | case manager | new version number; prior recommendation -> SUPERSEDED | recommendation.draft_requested |
| 15 | withdraw | any except CLOSED | WITHDRAWN | consumer | — | case.withdrawn, party.notified |
| 16 | close_case | RESOLVED_CONSENT, RESOLVED_DECLINED, WITHDRAWN | CLOSED | case manager | export bundle generated and hashed | export.generated, case.closed |

Deadline/timeout behavior (configurable, default 14 days per step): approaching-deadline notifications at T-3 days; on expiry the case manager is notified — the machine never auto-advances a material step. Expiry emits `deadline.expired` and requires human action.

---

## 7. Consent lifecycle

Per party, per recommendation version:

```
NOT_GIVEN --give--> GIVEN --revoke--> REVOKED
NOT_GIVEN --decline--> DECLINED
REVOKED --give--> GIVEN   (new explicit action, new timestamp)
DECLINED is terminal for that version; a new version resets that party to NOT_GIVEN.
```

Requirements:

- **Explicit UI action.** Consent is a dedicated screen/panel showing: the exact recommendation version (with link to full text), the consent statement in the user's locale, and two buttons of equal visual weight: "I consent / Je consens" and "I decline / Je refuse". No pre-selection. Revocation ("Withdraw my consent / Retirer mon consentement") must be as easy to find as granting.
- **Identity binding (AELFIT / CCQ art. 2827 posture).** The `authContext` records session id, authentication method (passkey), and a salted hash of the IP. The consent record, the statement wording version, and the recommendation version together constitute the proof package.
- **Version binding.** Consent applies to exactly one recommendation version. If a new version is issued, prior consents remain on the record (historical truth) but the new version starts at NOT_GIVEN for both parties.
- **Announcement.** Consent state changes are announced to assistive technology via `aria-live="polite"` regions and confirmed by bilingual email to both parties.
- **Never implied.** Silence, inactivity, or deadline expiry never counts as consent. There is no code path that writes GIVEN except the party's own authenticated action.

---

## 8. Event log and audit trail

- Append-only `events` table. A PostgreSQL trigger raises an exception on any UPDATE or DELETE. Migrations must never disable it.
- **Hash chain:** for each case, `hash = SHA256(prev_hash || canonical_json(payload) || actorId || seq || createdAt_iso)`. Genesis `prev_hash` is 64 zero characters. Canonical JSON = sorted keys, no whitespace, UTF-8.
- **EventType catalogue:** case.created, case.submitted, case.assigned, coi.declared, evidence.intake_opened, evidence.submitted, evidence.superseded, evidence.intake_closed, position.submitted, recommendation.draft_requested, recommendation.drafted, recommendation.issued, recommendation.superseded, consent.given, consent.declined, consent.revoked, case.resolved, case.resolved_declined, case.reopened, case.withdrawn, case.closed, export.generated, deadline.expired, party.notified, note.added, access.staff_granted.
- **Timeline view:** the case workspace renders the event log as a human-readable, bilingual timeline (projection; never edited). Case managers see all events; parties see all events except `recommendation.drafted` (quarantine) and internal `note.added` flagged private.
- **Verification job:** `npm run verify:events` recomputes the chain for all cases and rebuilds projections from events; exits non-zero on mismatch. Runs in CI and nightly in prod.

---

## 9. Recommendation engine (Claude API)

**Pipeline:** case manager clicks "Request draft" -> system assembles a prompt containing the case's evidence metadata + extracted text, both positions, and the glossary constraints -> Claude returns a structured draft -> validated against the schema -> stored as `DRAFT` (invisible to parties) -> case manager reviews, edits if needed -> issues.

**Explanation record schema (validate on write, e.g. with Zod):**

```json
{
  "summary": "string, plain language, <= 120 words",
  "proposed_outcome": "string — what is proposed, in prose",
  "reasoning": "string — why, step by step, in plain language",
  "evidence_citations": [
    { "evidence_item_id": "uuid", "relevance": "string" }
  ],
  "limits": ["string — what this recommendation does not account for"],
  "not_considered": ["string — categories of information absent from the file"],
  "model": { "id": "string", "prompt_version": "string" },
  "reviewer": { "user_id": "uuid|null until issued", "issued_at": "datetime|null" }
}
```

**Hard constraints:**
- Every `evidence_item_id` must resolve to an evidence item in the same case with `scanStatus=CLEAN`; simulated evidence only in simulated cases. Validation failure = draft rejected, event `recommendation.drafted` is not emitted, case manager sees a validation error.
- No numeric scores, percentages of fault, or star ratings anywhere in the output. Quantified amounts (e.g., a refund figure) are allowed only when traced to cited evidence in `reasoning`.
- Prompt requires the model to populate `limits` and `not_considered` non-emptily; empty arrays fail validation. A recommendation that claims no limits is definitionally overclaiming.
- Drafts are generated in the case's primary locale, then translated; the case manager reviews both before issuance. Both locale versions are stored in the explanation record.
- Use the Anthropic SDK's structured output / tool-use mode so the response is schema-conformant by construction. Pin `ANTHROPIC_MODEL`; record it per draft.
- The prompt itself is versioned (`prompt_version`); prompts live in `src/ai/prompts/` with a changelog. Prompt changes require the same review as code.

**UI for issuance (case manager only):** side-by-side draft and editable view, citation list with one-click jump to each evidence item, a checklist that must be affirmatively completed ("I have reviewed the cited evidence", "I confirm the stated limits are accurate", "I accept responsibility as the issuing reviewer"), then the issue button. The checklist is not pre-checked.

---

## 10. Roles, permissions, and views

| Capability | Consumer | Retailer handler | Case manager |
|---|---|---|---|
| Create/submit case | yes (own) | no | no |
| Submit evidence | yes (own case) | yes (assigned case) | no |
| Submit position | yes | yes | no |
| View evidence | own case, all parties' items | assigned case | assigned case |
| View draft recommendation | never | never | yes |
| Issue recommendation | no | no | yes |
| Give/decline/revoke consent | yes (self) | yes (self) | no |
| Add private case note | no | no | yes |
| Generate export | own closed case | assigned closed case | any assigned case |
| View full event timeline | filtered | filtered | full |

Every case workspace header renders, for the current viewer: **role**, **authority** ("You can: submit evidence"), and **next action** ("Waiting on: retailer's position"). This is derived from the state machine + role, never hardcoded copy. Implement `getAuthorityView(state, role, case)` as a pure function with unit tests for every state x role pair.

---

## 11. Evidence handling and simulated-data quarantine

- Uploads: multipart, size-capped (25 MB default), MIME-sniffed server-side, stored under `live/{caseId}/{evidenceId}` or `simulated/{caseId}/{evidenceId}` — the prefix is chosen from the case flag and cannot be influenced by the request body.
- SHA-256 computed at intake and stored; re-verified on export.
- Scan pipeline: PENDING on upload -> ClamAV/provider scan -> CLEAN (visible to other party) or REJECTED (quarantined, submitter notified). Nothing with PENDING status is ever shown to the other party or cited by the AI.
- Superseding creates a new version linked via `supersedesId`; prior versions remain readable in the timeline (attributability), marked "superseded / remplacé".
- **Simulated mode:** a case created with `simulated=true` shows a persistent banner on every screen: "Simulated case — training data / Dossier simulé — données d'apprentissage" (text + icon, never color alone). Simulated cases cannot be closed into a live export, cannot involve real counterparties' accounts, and are excluded from any future analytics. Seed data is simulated.

---

## 12. Internationalization and French parity (Bill 96 posture)

- `fr-CA` is the default locale; `en-CA` is co-equal. Locale negotiation respects user preference; every screen, email, PDF, and error message exists in both.
- All strings via next-intl message catalogs. A CI check fails the build if any key exists in one locale but not the other, and if any forbidden term ("decision/décision" for recommendations, "auto-approve", "score") appears in user-facing catalogs.
- Maintain a terminology glossary (`src/i18n/glossary.ts`) as the single source for legally loaded terms:

| Concept | EN | FR |
|---|---|---|
| proposed outcome | proposed outcome | résultat proposé |
| issue (a recommendation) | issue | rendre (une recommandation) |
| consent | consent | consentir / consentement |
| withdraw consent | withdraw consent | retirer son consentement |
| evidence | evidence | pièce / élément de preuve |
| neutral case manager | neutral case manager | gestionnaire de dossier neutre |
| simulated case | simulated case | dossier simulé |
| position | position | position |
| reviewer | reviewer | réviseur |

- Consent statement wording is versioned content (`ConsentStatementVersion`), reviewed by a Quebec lawyer before first production use — flagged as a human task, not a code task.

---

## 13. Accessibility — WCAG 2.2 AA implementation map

| Criterion | Implementation requirement |
|---|---|
| 1.4.1 Use of Color | Consent states, scan statuses, and simulated banners use text + icon + position; color is redundant only |
| 1.4.11 Non-text Contrast | Icons, focus indicators, control boundaries >= 3:1 |
| 2.4.11 Focus Not Obscured | Sticky headers/banners must never cover the focused element; test with keyboard walkthrough of the workspace |
| 2.5.7 Dragging Movements | No drag-only interactions (file upload has a browse button; reordering, if any, has buttons) |
| 2.5.8 Target Size | All interactive targets >= 24x24 CSS px; design tokens enforce a 44px comfortable default |
| 3.2.6 Consistent Help | Help/contact link in the same position on every screen |
| 3.3.7 Redundant Entry | Never ask for the same info twice in a flow; intake wizard persists |
| 3.3.8 Accessible Authentication | Passkeys + password-manager-friendly fallback; no CAPTCHAs, no memory puzzles |
| 4.1.3 Status Messages | Consent changes, issuance, upload completion announced via `aria-live` |
| Reduced motion | `prefers-reduced-motion` disables all non-essential animation; default transitions <= 150ms |

Keyboard operation is complete for every flow (intake wizard, evidence upload, consent, issuance checklist). Visible focus ring is part of the design tokens, not an afterthought. Run axe-core on every core screen in both locales in CI; zero-violation gate. One manual screen-reader pass (NVDA or VoiceOver) on the full dispute lifecycle before launch — human task.

---

## 14. Compliance requirements (build-time consequences)

- **Quebec Law 25:** PIA (ÉFVP) must be completed before any live personal data touches the system — produce the template in `/compliance/pia-template.md` as part of M6; filling it is a human task. Consent management, breach runbook (`/compliance/breach-runbook.md`), and retention schedule (closed cases retained 7 years, then anonymized — implement `npm run privacy:anonymize`) are code deliverables. Data residency: Canada-region storage and database by default; any cross-border processing requires a documented assessment.
- **Automated-decision posture (Law 25 s. 12.1):** the human-issuance gate (guardrail 4) is the compliance mechanism — no decision about a user is ever exclusively automated. The explanation record provides the disclosure artifact. Do not weaken this in any phase.
- **Bill 96 / Charter of the French Language:** Section 12's parity requirements are the implementation; FR is not optional at any milestone.
- **AELFIT / CCQ art. 2827:** consent identity binding + document integrity (Section 7) is designed so consent records are defensible as electronic signatures. Hash-chained events + SHA-256 evidence integrity support admissibility.
- **CCP art. 1 positioning:** the sealed export (Section 15) is deliberately suitable as evidence that a party considered private dispute resolution before court.
- **PIPEDA:** applies to interprovincial data flows; the Law 25 controls above are the stricter superset for v1.

---

## 15. Sealed export bundle

On case closure (and on demand for closed cases), generate a bundle containing:

1. `case-record.pdf` — bilingual, human-readable: parties, timeline (rendered from events), evidence manifest with SHA-256 hashes, all recommendation versions with reviewer attribution and explanation records, complete consent history with statement versions and timestamps.
2. `case-record.json` — machine-readable equivalent, including the full event chain with hashes.
3. `verification.txt` — instructions to independently recompute the hash chain and evidence hashes.

Store the bundle, record its SHA-256 in `ExportBundle`, emit `export.generated`. The PDF must meet the same FR/EN parity and be tagged/accessible (readable reading order, real headings).

---

## 16. API surface (route handlers / server actions)

All under `[locale]`-agnostic `/api`. Every mutation uses the Section 4 pipeline.

- `POST /api/cases` — create draft (consumer)
- `GET /api/cases` — list, role-scoped (plain list; no metrics dashboard)
- `GET /api/cases/[id]` — workspace projection (role-filtered)
- `POST /api/cases/[id]/submit` — DRAFT -> OPEN
- `POST /api/cases/[id]/evidence` — multipart upload
- `POST /api/cases/[id]/evidence/[eid]/supersede`
- `POST /api/cases/[id]/positions`
- `POST /api/cases/[id]/draft-requests` — case manager
- `GET /api/cases/[id]/draft` — case manager only
- `POST /api/recommendations/[id]/issue` — case manager, with checklist payload
- `POST /api/cases/[id]/consent` — body `{ action: "give" | "decline" | "revoke" }`
- `POST /api/cases/[id]/close` — case manager
- `POST /api/cases/[id]/withdraw` — consumer
- `GET /api/cases/[id]/events` — timeline (role-filtered)
- `GET /api/cases/[id]/export` — generate/fetch bundle
- `POST /api/auth/webauthn/register`, `POST /api/auth/webauthn/authenticate`

Errors are bilingual, specific, and never leak other parties' data (RBAC failures return 404, not 403, for non-assigned cases).

---

## 17. UI screens and design tokens

**Screens:** sign-in/register (passkey), case list, case intake wizard (consumer), case workspace (shared shell, role-scoped panels: Authority header / Evidence / Positions / Recommendation / Consent / Timeline), draft review + issuance (case manager), export view, simulated-mode banner (global, persistent), help page (consistent position).

**Design tokens (`src/ui/tokens.ts`):** neutral palette — ink `#1B1E23`, paper `#FAF9F7`, muted `#6B7280`, one restrained accent (deep slate blue `#2F4A6B`) reserved for primary actions; semantic hues (consent-given, declined, warning) always paired with icon + label. Type: system serif for headings, system sans for body; base 16px, 1.5 line height. Spacing scale 4/8/16/24/32/48. Min interactive target 44px token. Focus ring: 2px solid accent with 2px offset, never removed. Motion: <= 150ms ease-out, disabled under reduced motion. No gradients, no glassmorphism, no confetti, no gamification.

---

## 18. Testing strategy

- **Unit (Vitest):** state machine — exhaustive test that every (state, trigger, role) triple matches the Section 6 table; guards return correct reasons; hash-chain computation; explanation-record validation (including citation resolution and simulated-data rules); consent lifecycle transitions.
- **Integration:** full mutation pipeline writes domain row + event + projection atomically (rollback on event failure); RBAC negative tests for every endpoint x role; consent binds to correct recommendation version.
- **E2E (Playwright):** complete dispute lifecycle in `fr-CA` and in `en-CA`: intake -> evidence -> positions -> draft -> issue -> consent both parties -> export; plus decline path, revoke path, withdraw path, simulated-case banner presence.
- **A11y:** axe-core on every core screen, both locales, zero violations; keyboard-only run of the consent flow.
- **Integrity:** `verify:events` on seeded data in CI; tamper test (manually modify an event row in a test DB -> verification must fail).
- **Isolation test:** prove a simulated evidence item cannot be attached to a live case and cannot appear in a live draft's citations.

---

## 19. Milestones and acceptance criteria

**M0 — Scaffold.** Repo, TypeScript strict, Prisma + Postgres (Docker Compose), next-intl with FR default, tokens, CI (lint, typecheck, i18n-parity check, forbidden-terms lint). *Done when:* empty app builds, CI green, FR/EN catalogs enforced.

**M1 — Event log + state machine + auth.** Passkey auth, `events` table with append-only trigger and hash chain, state machine + guards, mutation pipeline, `verify:events`. *Done when:* Section 18 unit + integrity tests pass; tamper test fails verification as designed.

**M2 — Cases, evidence, positions.** Intake wizard, case assignment, evidence upload with scan pipeline and versioning, positions, role-scoped workspace with authority header, timeline view. *Done when:* M2 E2E segment passes in both locales; RBAC negative tests pass.

**M3 — AI drafting + issuance.** Claude integration, explanation-record validation, quarantined drafts, review + checklist + issue flow, COI declaration gate. *Done when:* a draft with an unresolvable citation is rejected; nothing is visible to parties before issuance; issued recommendation renders with citations, limits, and named reviewer.

**M4 — Consent lifecycle.** Consent panel (equal-weight actions, no pre-selection), version binding, revocation, bilingual notifications, aria-live announcements. *Done when:* consent E2E paths pass; audit shows statement version + auth context recorded; no code path writes GIVEN without party action (code review checklist item).

**M5 — Export + closure.** Sealed bundle (PDF + JSON + verification), closure flow, retention/anonymize job. *Done when:* exported JSON replays to the same projection; PDF is bilingual and accessible.

**M6 — Hardening + compliance pack.** axe zero-violation gate on all flows, PIA template + breach runbook + privacy policy drafts in `/compliance`, seed data (simulated), README + DECISIONS.md complete, manual screen-reader pass scheduled (human task listed in launch checklist).

---

## 20. Definition of done (every milestone)

- Tests for the milestone pass in CI, in both locales where UI is involved.
- No new user-facing string exists in only one locale.
- Every new mutation emits its event(s) and appears in the timeline.
- axe-core: zero violations on new/changed screens.
- No forbidden terminology, no scores, no pre-selected consent — verified by CI lint and code review.
- Decision log updated for any deviation from this document.

---

## Appendix A — Seed data

One simulated case (`simulated=true`, banner visible) with two parties, a case manager, three evidence items, two positions, one issued recommendation, and mixed consent states — enough to demo every screen. No real personal data in seeds.

## Appendix B — Human tasks the code cannot do

1. Quebec lawyer review of consent statement wording (FR + EN) before production.
2. Complete the PIA/ÉFVP before live data.
3. Manual screen-reader pass before launch.
4. Privacy officer designation and breach-runbook ownership.
5. Prompt review sign-off whenever `src/ai/prompts/` changes.
