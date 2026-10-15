# AEQUITAS: Spec Sheet

Derived from `PRODUCT.md`, `docs/aequitas-core-backend.md`, `DECISIONS.md`, the Prisma schema, `src/domain/stateMachine.ts`, and the phase 1–3 and deployment notes. It separates implemented behavior from stated targets. Live AI quality and the CT920 cutover remain unverified (see section 11).

## 1. What it is

A human-reviewable conflict knowledge and dispute-resolution workspace. It turns contested narratives into a traceable map of claims, evidence, competing interpretations, context, lived experience and repair options. It then supports a documented process in which a human case manager reviews an AI-drafted **recommendation**, and the parties give or withhold **consent**. It is not an adjudication engine and does not give legal advice.

**Users:** a complainant and a respondent (two-party model), an assigned case manager, and an admin. Dispute categories: retail, tenancy, employment, B2B, freelance, P2P marketplace, partnership. Jurisdiction scope: Québec/Canada. Bilingual (fr-CA and en-CA).

## 2. The promises

1. **A recommendation is never a decision.** The word "decision" is a hard-forbidden term (checked by `check:forbidden-terms`). Nothing is issued without a human review checklist.
2. **Consent is explicit and reversible.** Nothing is pre-selected. Consent is tracked per party and per recommendation version. A new version resets it.
3. **Every material step is attributable.** Each action is an event with an actor, a timestamp and a tamper-evident hash chain.
4. **Recommendations explain themselves.** Each one states its evidence, its limits, what was not considered, and who reviewed it.
5. **Disagreement and uncertainty are preserved.** Synthesis is conditional and never forces consensus. Labels are qualitative proposals, never probabilities or credibility scores.
6. **Experience, evidence, identity and causal interpretation stay distinct.**
7. **Compliance is evidenced, not asserted.** Simulated data can teach the workflow but never impersonates live evidence.
8. **Every role sees its authority and next action.** The UI never grants a permission on its own. Disabled forms stay visible with an explanation.
9. **Honest degradation.** With no AI key, no database or no legal-research source, the system says so plainly. It never fabricates, for example a statute citation.
10. **Accessibility:** WCAG 2.2 AA target, with keyboard operation, visible focus, reduced motion and colour-independent state cues.

## 3. The method (`aequitas-core-v1`)

From `Aequitas Core.txt`.

- **Dialectics:** state the strongest claim and the strongest counterclaim, test both, then synthesise.
- **Trialectics:** add the neglected third factor (institution, history, relationship), using `K = f(Evidence, Positionality, Context)`.
- **Triangulation:** compare across data, investigators, theory and method, and check that sources are independent. Five sources repeating one claim count as one.

## 4. How a case works

**States:** `DRAFT → OPEN → EVIDENCE_INTAKE → POSITIONS → DRAFTING → ISSUED → RESOLVED_CONSENT | RESOLVED_DECLINED`, plus `WITHDRAWN` and `CLOSED`. The transition table in `stateMachine.ts` is the single source of truth: 18 triggers, each with role and guard rules.

| Step | Who | What happens |
|---|---|---|
| Create and submit case | Complainant | Starts in DRAFT, then OPEN. Category is chosen. |
| Respondent invite | Admin or complainant path | Single-use invite link (HMAC-signed, 72 h). |
| Assignment and COI declaration | Case manager | The manager declares any conflict, then opens intake. |
| Evidence intake | Either party | Upload evidence (document, photo, message, receipt, other). Add dated chronology entries. Evidence is superseded, never overwritten. |
| Close intake | Case manager | Parties can no longer add evidence. |
| Positions | Either party | Versioned position statements (managers review but do not submit). |
| Draft request | Case manager | Triggers AI drafting. |
| Draft correction | Case manager | Edits create a new version; the old one is kept as SUPERSEDED. A reason is required. |
| Issue | Case manager | Passes the human checklist. Graph integrity and clean evidence are rechecked. |
| Consent | Each party | Give, decline or revoke. Both GIVEN gives `RESOLVED_CONSENT`. A decline gives `RESOLVED_DECLINED`. |
| Contestation | Party or assigned manager | Open a challenge to a claim, synthesis, proposal or recommendation. An open contestation blocks consent-based resolution. |
| Approver sign-off | Separate authorized case manager | New cases require a recorded rationale and approval of the current recommendation before consent can resolve them. Existing migrated cases retain consent-only resolution. |
| Withdraw or close | Party or manager | Withdraw is allowed from any non-closed state. Closing produces the export. |

**Consent machine:** `NOT_GIVEN → GIVEN → REVOKED → GIVEN`. `NOT_GIVEN → DECLINED` is terminal for that version.

**Chronology:** each entry holds the reported calendar date, title, original description, author, language and submission time. A clarification is a new entry. Nothing is treated as verified fact, and repeated accounts are not corroboration.

**Traceable claim layer:** the assigned manager can record sources, typed claims, exact excerpts, claim relationships and review notes. Parties can inspect the provenance behind claims about their case. An impact statement remains reported experience. These writes append audit events without changing the case state.

**Optional proposal pipeline:** when `AEQUITAS_PIPELINE_ENABLED=true`, an acknowledged assumption ledger gates model proposals for claim decomposition and context. Proposals remain separate from accepted claims. Synthesis validation requires provenance and flags disputed claims; it does not produce numeric credibility scores. The configured provider is Gemini or Workers AI.

## 5. The AI drafting pipeline

1. **Gather sources.** Clean evidence is downloaded and checked against its recorded size and SHA-256 hash. Text is extracted from UTF-8, PDF (`pdftotext`) and images (OCR with `tesseract`). The server also snapshots both positions and the chronology.
2. **Legal research (optional).** One LegiPro query per draft (`/v0/search/routed`), scoped to category plus Québec/Canada. Results become quotable `legal_research` sources. If unconfigured or failing, the list is empty and the model must say no legal research was available.
3. **Prompt and generation.** The router sets the domain; the prompt is versioned (`2026-09-22.1`). The model returns structured output.
4. **Validation.** Rejected outputs include: missing sources; fabricated or translated-as-original excerpts; dangling or duplicate node IDs; double-counted sources; identical files placed in separate source groups; unsupported documented context; synthesis labels that contradict the underlying claim assessments.
5. **Persist.** Stored as a versioned JSON document at `Recommendation.explanation.conflict_knowledge`. The server, not the model, writes the source registry, model metadata and reviewer identity.

**The Conflict Knowledge Map contains:**

- atomic claims (factual, causal, moral, identity, policy, experience) with exact source excerpts;
- competing narratives with standpoint and assumptions;
- context (material, narrative, relational), with documented factors kept apart from hypotheses and unknowns;
- reported experiences, recognition needs and voluntary-disclosure safeguards;
- typed relationships with explicit uncertainty;
- separate data, investigator, theory and method assessments, including missing evidence;
- conditional synthesis with revision conditions;
- repair options with prerequisites, accountability and consent.

**Limits:** exact-excerpt matching proves traceability only, not truth, independence, relevance or legal liability. Extraction caps: 25 MiB per file, 20 PDF pages, 12,000 characters per source, 12 files and 60,000 characters per case. Scanned PDFs are not OCRed.

## 6. Access control

- **Passkeys (WebAuthn) only.** Passkey registration never attaches to an existing email without a session. Managers cannot self-register and arrive through an admin invitation.
- **Draft access:** the assigned manager sees the draft and graph. Parties see the map only after issuance. Everyone else gets 404, including other managers and admins without case participation.
- **Case read:** only the assigned manager gets the full case. Other managers see an OPEN, unclaimed case with a party-level timeline. Admins get the party-level view.
- Responses are private and non-cacheable.
- **Concurrency:** generation, correction and issuance run under a transactional case-row lock. Stale operations return a conflict.

## 7. Audit and integrity

- **Event log** with `prevHash` and `hash` (a hash chain). A database trigger blocks mutation, and a tamper test checks it.
- **Replay:** `verifyEvents` and `replay` rebuild case state from events and compare it with the stored projection.
- **Event types** cover case lifecycle, COI, evidence, chronology, draft request, draft, issue and supersede, consent, export, and access events.
- **Evidence safety:** ClamAV scan (`PENDING / CLEAN / REJECTED`), a MIME allowlist, upload limits and a SHA-256 check before extraction. The proxy body limit accommodates a 25 MiB file plus multipart framing.

## 8. Export

JSON export carries the full graph, source snapshot and chronology. The sealed PDF (`pdf-lib`) carries the full map and source snapshots, and is stored in an `ExportBundle`.

## 9. Interface

- Next.js app with locale routes `/fr-CA` and `/en-CA`; `/` redirects.
- A landing page, a case list ("My cases"), and a case workspace with three section links (Evidence, Positions, Chronology) showing role- and stage-specific guidance.
- A knowledge-map explorer and a bilingual review form for editing claims, interpretations, context, relationships and repair paths.
- A case timeline and case activity log.
- i18n parity is enforced by `check:i18n-parity`.

## 10. Stack

Next.js 16 / React 19, TypeScript, Prisma 7 + PostgreSQL, S3-compatible or local-volume evidence storage, ClamAV, Anthropic SDK (Claude), optional Gemini or Workers AI proposal provider, next-intl, SimpleWebAuthn, pdf-lib, zod 4, Vitest + Playwright (+ axe-core). The development Compose stack uses Postgres, MinIO and ClamAV on loopback. The parallel CT920 stack uses Postgres, ClamAV and a local evidence volume. Tests select the separate `aequitas_test` database.

## 11. Known gaps (stated in the repo)

- **Live AI quality is unverified.** Automated tests use synthetic records; a live-provider quality assessment is still required.
- **Hosting is split.** Railway is the public production deployment. The private demo is loopback-only on CT920 (port 3417). A separate `aeq-prod` stack is running on CT920 loopback as a parallel dry run; no public cutover has occurred. See `docs/ct920-standup.md`.
- **Two parties only.** No multi-party membership.
- **No retention or deletion service** and no translation-review workflow.
- **Invitation delivery has no background retry scheduler.** Administrators can revoke stored invitations and retry pending notification delivery from the interface.
- **Storage cleanup after process death is manual.** Failed writes normally remove new objects, but no periodic storage sweeper is installed.
- **CT920 cutover is gated.** A fresh Railway data copy, evidence verification, off-box backups, hostname/passkey decision and Martin's explicit cutover approval are required by the runbook.
