# AEQUITAS: Spec Sheet

Derived from `PRODUCT.md`, `docs/aequitas-core-backend.md`, `DECISIONS.md`, the Prisma schema, `src/domain/stateMachine.ts`, and the phase 1–3 and deployment notes. It separates implemented behavior from stated targets. Live AI quality and the CT920 cutover remain unverified (see section 11).

## 1. What it is

A bilingual dispute-resolution service with staff-led cases and an optional autonomous path for configured, eligible routine retail cases. In agent-managed cases, Aequitas can handle intake, evidence, positions and a structured, non-binding, evidence-grounded proposal without case-manager action. Each party controls their own submissions and consent. The agent does not adjudicate, determine truth or give legal advice; uncertainty, out-of-scope cases, failed checks, declines and requests for a person go to program staff. The agent is off by default, and its live-model quality and production operation remain unverified.

**Users:** a complainant and a respondent (two-party model), an assigned case manager, and an admin. Dispute categories: retail, tenancy, employment, B2B, freelance, P2P marketplace, partnership. Jurisdiction scope: Québec/Canada. Bilingual (fr-CA and en-CA).

## 2. The promises

1. **A proposal is not an adjudication.** The case agent may handle only configured, eligible routine cases and issue a non-binding proposal. It does not decide who is truthful, apply law, or give legal advice. Scope problems, uncertainty and failed checks go to staff.
2. **Consent belongs to each party.** Nothing is pre-selected. Each response is explicit and bound to the outcome version. Both parties must consent before an agent-managed proposal can close the case; a new version resets consent.
3. **Every material step is attributable.** Each action is an event with an actor, a timestamp and a tamper-evident hash chain.
4. **Proposals show their evidence and limits.** Staff receive the shared summary and rationale. Each party sees fixed wording for their own outcome and excerpts from their own evidence only.
5. **Disagreement and uncertainty are preserved.** The case agent does not score credibility or force consensus. A decline, contestation, request for a person, unanswered proposal or uncertain input goes to staff.
6. **Experience, evidence, identity and causal interpretation stay distinct.**
7. **Compliance is evidenced, not asserted.** Simulated data can teach the workflow but never impersonates live evidence.
8. **Every role sees its authority and next action.** The UI never grants a permission on its own. Parties can ask for a person; staff receive exceptions and escalations.
9. **Honest degradation.** Agent mode is off unless enabled with complete program rules and provider configuration. If the model or evidence checks fail, the case goes to staff; missing legal research is never fabricated.
10. **Accessibility:** WCAG 2.2 AA target, with keyboard operation, visible focus, reduced motion and colour-independent state cues.

## 3. The method (`aequitas-core-v1`)

From `Aequitas Core.txt`.

- **Dialectics:** state the strongest claim and the strongest counterclaim, test both, then synthesise.
- **Trialectics:** add the neglected third factor (institution, history, relationship), using `K = f(Evidence, Positionality, Context)`.
- **Triangulation:** compare across data, investigators, theory and method, and check that sources are independent. Five sources repeating one claim count as one.

## 4. How a case works

**States:** `DRAFT → OPEN → EVIDENCE_INTAKE → POSITIONS → DRAFTING → ISSUED → RESOLVED_CONSENT | RESOLVED_DECLINED`, plus `WITHDRAWN` and `CLOSED`. The transition table in `stateMachine.ts` is the single source of truth: 18 triggers, each with role and guard rules.

| Step | Who | What happens in staff-led cases |
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
| Approver sign-off | Separate authorized case manager | New human-managed cases require a recorded rationale and approval of the current recommendation before consent can resolve them. Agent-managed cases also require sign-off by default. Consent-only resolution is available only when the program explicitly enables it after owner and governance approval; escalation restores the approval requirement. |
| Withdraw or close | Party or manager | In human-managed cases, the complainant may withdraw. In agent-managed cases, the complainant may always withdraw and the respondent may do so only when the program explicitly enables it. Closing produces the export. |

**Optional agent-managed path (off by default):** The service may take only a submitted, unassigned `OPEN` `RETAIL` case with a known amount within the configured limit. It invites the respondent, waits for both parties to join, waits for each party to mark evidence intake complete with clean evidence, and then requests both positions. It verifies current evidence files and extracts text before asking the model for a staff-only summary, exact excerpts and a remedy from a closed list. A locked write issues both version-bound outcomes and citations together. Both parties must consent to close; a decline, timeout, contestation, failed evidence or model check, or request for a person hands the file to staff. Parties receive only fixed bilingual wording and excerpts from their own evidence. See [case-agent-prototype.md](case-agent-prototype.md) for precise rules, limits and handoff reasons.

**Consent machine:** `NOT_GIVEN → GIVEN → REVOKED → GIVEN`. `NOT_GIVEN → DECLINED` is terminal for that version.

**Chronology:** each entry holds the reported calendar date, title, original description, author, language and submission time. A clarification is a new entry. Nothing is treated as verified fact, and repeated accounts are not corroboration.

**Traceable claim layer:** the assigned manager can record sources, typed claims, exact excerpts, claim relationships and review notes. Parties can inspect the provenance behind claims about their case. An impact statement remains reported experience. These writes append audit events without changing the case state.

**Optional proposal pipeline:** when `AEQUITAS_PIPELINE_ENABLED=true`, an acknowledged assumption ledger gates model proposals for claim decomposition and context. Live case-data calls also require explicit provider-terms review; Gemini requires a separate operator confirmation that its API project uses the paid tier. Proposals remain separate from accepted claims. Synthesis validation requires provenance and flags disputed claims; it does not produce numeric credibility scores. The configured provider is Gemini or Workers AI.

## 5. The AI drafting pipeline

1. **Gather sources.** Clean evidence is downloaded and checked against its recorded size and SHA-256 hash. Text is extracted from UTF-8, PDF (`pdftotext`) and images (OCR with `tesseract`). PDF pages without text-layer content are rendered at bounded resolution and OCRed. The server also snapshots both positions and the chronology.
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

**Limits:** exact-excerpt matching proves traceability only, not truth, independence, relevance or legal liability. OCR may misread or omit text. The PDF extractor detects pages with embedded image objects, renders and OCRs those pages, and uses the OCR text for that page; the case agent hands the file to staff if extraction is partial or unreadable. Extraction caps: 25 MiB per file, 20 PDF pages, 12,000 characters per source, 12 files and 60,000 characters per case.

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
- A landing page, a case list ("My cases"), and a case workspace with role- and stage-specific guidance for staff-led and optional agent-managed cases.
- A knowledge-map explorer and a bilingual review form for editing claims, interpretations, context, relationships and repair paths.
- A case timeline and case activity log.
- i18n parity is enforced by `check:i18n-parity`.

## 10. Stack

Next.js 16 / React 19, TypeScript, Prisma 7 + PostgreSQL, S3-compatible or local-volume evidence storage, ClamAV, next-intl, SimpleWebAuthn, pdf-lib, zod 4, Vitest and Playwright. The case-agent route allows Gemini or Cloudflare Workers AI; it rejects Anthropic and OpenAI. The development Compose stack uses Postgres, MinIO and ClamAV on loopback. Tests select the separate `aequitas_test` database.

## 11. Known gaps (stated in the repo)

- **Live AI quality is unverified.** Automated tests use synthetic records and a stub model. The live evaluation is explicitly gated and still required before any real case.
- **Production source provenance and current public availability are unconfirmed.** A previous read-only check on 2026-11-06 returned HTTP 200 from `/api/health` with release `d74ed342693a96a6dc75d8907d288131c0148385`; GitHub does not resolve that SHA in this repository. On a later check from the Codex Mac client on 2026-11-06, `/api/health`, both locale home pages, and both candidate demo routes returned HTTP 403. That client-level result does not distinguish edge filtering from an app-wide outage. The live source, demo availability, provider settings, worker state, and data/backup health remain unverified.
- **Two parties only.** No multi-party membership. Roles are global, so the current product is one program per isolated deployment, not a multi-tenant SaaS.
- **No retention or deletion service** and no translation-review workflow. The append-only event chain makes personal-data deletion a design decision.
- **Notification retry and case-agent scheduling are opt-in deployment services.** The CT920 `scheduled` Compose profile retries queued notifications every 15 minutes and invokes the case agent every 10 minutes; neither is started by the default web stack. The agent also requires explicit program and provider settings.
- **Identity and operations need host verification.** Real passkey enrollment, identity checks before re-enrolling existing users, email delivery, retries, scanner operation and the scheduled worker have not been verified on the selected pilot host.
- **Commercial terms are absent.** Pricing, billing, contract terms and data-processing terms are not set or built.
- **Storage cleanup after process death is manual.** Failed writes normally remove new objects, but no periodic storage sweeper is installed.
