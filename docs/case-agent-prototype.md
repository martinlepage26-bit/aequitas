# Case agent (2026-11-05)

Status: **off by default; tested on synthetic data with a stub model only.** No live model has been evaluated. Do not enable it for real cases before the decisions at the end of this page are made.

## Routine path it handles without a case manager

All workflow decisions are deterministic code under the program's configured rules (`src/domain/caseAgent/config.ts`). The model only drafts a staff summary, picks a remedy from a closed list, and points to evidence excerpts. Every step below is a separate scheduled pass (`npm run agent:run`); each pass is idempotent and re-checks the case row under lock.

1. **Take the case.** A submitted `OPEN` case with no assigned manager is taken by the agent (`agent_open_intake`) only if it is `RETAIL` and its amount at stake is present and within the program limit. Anything else stays in the normal case-manager queue untouched. Both parties receive an explicit bilingual notice by email and on the case page: the agent handles routine steps, proposals are not binding, are not legal advice and do not judge truthfulness, participation is voluntary, and either party can ask for a person or end participation.
2. **Invite the respondent.** The agent sends the existing respondent invitation once (`PARTY_NOTIFIED` event, same invitation tables and email as the complainant-initiated path). If the invitation cannot be delivered, or the respondent has not joined within the program's response period, the case goes to a person.
3. **Collect evidence.** Parties upload through the existing evidence form: MIME allowlist, size limits, ClamAV scan, hash recorded. Each party must mark their own evidence intake complete; a new submission clears that party's mark, and a case-detail change clears both. The agent closes intake (`agent_close_intake`) only after both current marks and at least one clean item from each party, then queues a bilingual request for each party to submit or update their position. It can close as soon as both are ready. At the configured maximum period, an incomplete submission or a party who has not marked complete goes to a person; silence never counts as readiness. A pending scan makes it wait until that period ends, then goes to a person. A rejected file goes to a person immediately.
4. **Collect positions.** Parties submit positions as usual. A missing position after the response period goes to a person.
5. **Read the evidence and propose.** Before any model call the agent:
   - downloads every current clean item and checks its stored size and SHA-256
   - extracts text (see below)
   - stops for a person if anything is unreadable, partial or over the limits

   The model returns a staff-only summary, citations with exact excerpts, a structured proposal (`refund_full`, `refund_partial`, `store_credit`, `replacement` or `repair`, plus an amount where one applies), and the evidence each party's outcome relies on. Deterministic checks then require:
   - a strict schema with no extra fields
   - every excerpt appearing exactly once in the cited file's extraction
   - each party's outcome pointing only to that party's own evidence
   - an amount that is needed by the remedy and not above the amount at stake
   - no verdict, credibility, score, legal-advice, binding or pressuring language in any model text

   A failed check goes to a person; nothing is partially written.
6. **Issue.** One locked write (`agent_issue`) stores the recommendation, both party outcomes, per-outcome citation pointers and notifications. If any material the model saw changed during the call, the result is discarded as stale and redone on the next pass.
7. **Answers.** Parties consent or decline through the existing consent flow, which binds each answer to the outcome version. Independent approver sign-off remains required unless the program explicitly sets `AEQUITAS_CASE_AGENT_CONSENT_ONLY_RESOLUTION=true` after owner and governance approval. An unanswered proposal after the response period goes to a person.
8. **Close.** After both parties consent, or after either party ends participation, the agent generates the sealed export and closes the case (`agent_close`). A decline goes to a person; the agent never closes a declined case.

## Handoffs to a person

The agent stops, records `AGENT_ESCALATED` with a reason, and notifies the assigned case manager. If no manager is assigned, it notifies every case-manager account with a passkey (the program's queue). An unassigned escalated case appears in every case manager's list; one manager takes it by declaring no conflict of interest (`POST /api/cases/[id]/claim`). From then on, normal human rules apply, including approver sign-off.

Reasons:

| Area | Reasons |
|---|---|
| Party choice | `party_request` (either party, any time before closure), `declined` |
| Invitation and timing | `invitation_failed`, `respondent_no_response`, `submission_missing`, `intake_incomplete`, `evidence_scan_pending`, `no_answer` |
| Scope | `out_of_scope_category`, `out_of_scope_amount` |
| Evidence | `evidence_rejected`, `evidence_inadequate`, `evidence_extraction_failed`, `evidence_limit_exceeded` |
| Process | `contestation_open` |
| Program configuration | `program_rules_incomplete` |
| Model | `model_unavailable`, `model_failed`, `model_requested_review`, `model_output_rejected` |

## Evidence the agent actually reads

The agent reuses the existing pipeline in `src/lib/evidenceText.ts`:

| Format | Method | Notes |
|---|---|---|
| `text/plain` | UTF-8 decode | |
| PDF | `pdftotext` for text-only pages; `pdfimages` detects pages with embedded images, which are rendered with `pdftoppm` and OCRed with `tesseract` as a whole page | Up to 20 pages. A longer file is "partial" and goes to a person. The page number is recorded with each citation. OCR may misread text. |
| PNG, JPEG, TIFF, WebP | `tesseract` OCR | Languages from `AEQUITAS_OCR_LANGUAGES`. OCR text is cited as extracted, not corrected. |

- **Limits:** 25 MiB per file, 12,000 characters per source, 12 files and 60,000 characters per case. Exceeding any of them goes to a person.
- **Not read:** any page that remains empty after OCR, other formats (unsupported), and any truncated extraction. Each of these goes to a person. A filename or description is never treated as proof. When a page contains an embedded image, OCR replaces that page's text-layer extraction so visible text and scanned content are assessed together.
- **Citations:** each records the evidence id, start and end character offsets, the source-file SHA-256, the extracted-text SHA-256, the extraction method and, for PDFs, the page. A party opening a cited excerpt gets it re-extracted and re-verified against both hashes. Citation digests are bound to the issuance event and checked by `verifyCase`.
- **What an exact excerpt proves:** only that the text exists in the extraction. It does not prove the document is authentic, accurate or relevant.

## Privacy and party choice

- **Fixed party text.** No model-written sentence reaches a party. Each party reads fixed French or English wording generated from the structured proposal (`src/domain/caseAgent/proposal.ts`), plus excerpts from their own evidence only. The summary, reasoning and citation notes stay with staff. This replaces the earlier six-word overlap check, which could not prove that a paraphrase leaked nothing.
- **Isolation rules unchanged.** The existing submission-visibility contract still applies: parties never see the other side's submissions, outcome or request for a person.
- **Ending participation.** Either party can request a person until closure. The complainant can always end participation. The respondent can on agent-managed cases when the program setting `AEQUITAS_CASE_AGENT_RESPONDENT_MAY_WITHDRAW` is `true`; there is no default. Human-managed cases keep the existing complainant-only withdrawal rule.

## Permissions

- **Account.** The agent acts as one `CASE_AGENT` service account (`npm run agent:provision`). No session can be issued for that role and it has no passkey.
- **State machine.** It holds exactly `agent_open_intake`, `agent_close_intake`, `agent_issue` and `agent_close`, each guarded by `agentMayAct` (opted in, not escalated, actor is the agent). A unit test asserts it holds nothing else.
- **No case access.** `caseReadAccess` gives it nothing, so it cannot use any route.
- **What it cannot do.** Tests show it cannot consent, decline, approve, write outcomes as a manager, request a person, or administer users.
- **Audit.** Every agent write appends hash-chained events attributed to the agent, with the model id, the prompt version (`case-agent-2026-11-05.3`) and a digest of the material it saw.

## Program configuration (no defaults)

| Setting | Meaning |
|---|---|
| `AEQUITAS_CASE_AGENT_ENABLED=true` | Program-level switch. |
| `AEQUITAS_CASE_AGENT_MAX_AMOUNT_CENTS` | Largest amount at stake the agent may handle. |
| `AEQUITAS_CASE_AGENT_INTAKE_DAYS` | Maximum time from opening intake to complete evidence and mark both sides ready; an incomplete case goes to a person when it expires. |
| `AEQUITAS_CASE_AGENT_RESPONSE_DAYS` | Time to join after an invitation, to submit a position, and to answer a proposal. |
| `AEQUITAS_CASE_AGENT_RESPONDENT_MAY_WITHDRAW` | `true` or `false`. |
| `AEQUITAS_CASE_AGENT_CONSENT_ONLY_RESOLUTION` | `true` only if the owner explicitly approves removing independent approver sign-off for routine agent-managed cases; `false` keeps sign-off. This setting is recorded on each enrolled case. Escalation always restores the normal approval requirement. |
| `AEQUITAS_AI_PROVIDER_TERMS_REVIEWED=true` | Required before the agent sends case material to the chosen provider. Set only after reviewing the current terms for the exact provider, account and model; this is not privacy or legal approval. |
| `AEQUITAS_GEMINI_PAID_TIER_CONFIRMED=true` | Also required for Gemini. Confirm the exact API key belongs to a project with active billing; the app cannot inspect the provider billing tier. |

If program rules are missing or invalid, the agent takes no new case and hands active agent-managed cases back to staff. New cases also wait in the normal queue until an approved provider is configured. Email delivery must be configured for the respondent invitation; otherwise the case goes to a person.

**Runtime model.** The agent uses the existing `TextCompletion` interface: Gemini (`GEMINI_API_KEY`, optional `GEMINI_MODEL`) or Cloudflare Workers AI (`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, optional `AEQUITAS_WORKERS_AI_MODEL`), selected by `AEQUITAS_PIPELINE_PROVIDER`. Anthropic and OpenAI are refused on this path. Calls are billed to the deployment's own provider account, not to Claude Code Cloud credits. Current provider data terms and transfer conditions still require program and counsel review.

### Provider data handling checked 2026-11-05

- **Gemini API:** Google's terms classify unpaid Gemini API quota and direct Google AI Studio access as unpaid services. Google says prompts and responses may be used to improve products, human reviewers may process them, and sensitive, confidential, or personal information should not be submitted to unpaid services. For the paid Gemini API, an active Cloud Billing account is required; Google says prompts and responses are not used to improve products and are processed under its data processing addendum, but may be logged for a limited period for safety, security, or legal requirements and may be transiently stored or cached in any country ([Gemini API terms](https://ai.google.dev/gemini-api/terms), [billing requirements](https://ai.google.dev/gemini-api/docs/billing)).
- **Cloudflare Workers AI:** Cloudflare says standard inference requests that do not use a stateful feature are processed only as needed and inputs and outputs are not retained after processing; it also says Workers AI Customer Content is not used to train models. Exceptions include application logging, AI Gateway logging or caching, storage products, asynchronous or batch features, and other stateful features. The code's default is `@cf/meta/llama-3.1-8b-instruct-fp8`; Cloudflare marks it zero-data-retention and lists its current unit rates, while Meta's model card lists French as supported. That language label is not evidence of Québec French quality. The linked Meta license and acceptable-use policy still need commercial review ([Workers AI data usage](https://developers.cloudflare.com/workers-ai/platform/data-usage/), [default model page](https://developers.cloudflare.com/workers-ai/models/llama-3.1-8b-instruct-fp8/), [current pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/), [Meta model card](https://github.com/meta-llama/llama-models/blob/main/models/llama3_1/MODEL_CARD.md), [Llama 3.1 license](https://github.com/meta-llama/llama-models/blob/main/models/llama3_1/LICENSE)).

For the first live evaluation, Cloudflare Workers AI is the preferred candidate because its published standard-inference retention commitment is narrower. Cloudflare currently includes 10,000 free Neurons per day on its Workers Free plan; requests beyond that limit fail unless the account uses Workers Paid, where usage above the free allocation is charged. The default model is not listed among the models requiring a paid billing method. Use a test account on Workers Free and synthetic cases only so the evaluation cannot create paid overage; if Workers Paid is used, configure a spend limit. This is a provider-fit recommendation only: it does not establish data residency, satisfy counsel review, authorize a live call, or permit real case data. The operator must verify the exact account, model license, logging configuration and current agreement before setting `AEQUITAS_CASE_AGENT_EVAL_APPROVED=true` ([Workers AI pricing and limits](https://developers.cloudflare.com/workers-ai/platform/pricing/)).

**Scheduling.** `npm run agent:run` is one bounded pass. The opt-in CT920 `scheduled` Compose profile runs it every 10 minutes and notification retries every 15 minutes. It is not started by the default web stack. From `deploy/ct920`, use `RELEASE_SHA="$(git -C ../.. rev-parse HEAD)" docker compose -p aeq-prod --profile scheduled up -d scheduler`; inspect counts with `docker compose -p aeq-prod --profile scheduled logs scheduler`. The worker receives only database, event-chain, evidence-storage, email and provider settings; it has no web session or WebAuthn secrets. Each case is leased before a pass, revisited no sooner than 10 minutes later, and recovered after a 30-minute crashed-worker lease. A missing provider prevents new cases from being taken; already agent-managed cases can still close after consent or be handed back.

**Operator status.** `npm run agent:status` prints only aggregate readiness, case-state, escalation, lease and notification counts; it omits case IDs, party details, evidence, addresses and secrets. It reads database state and configuration, but does not prove the scheduler container is running or report provider billing. Check the scheduled-profile logs for job liveness and the provider account for usage.

## Evaluation

`npm run agent:evaluate -- --stub` exercises the harness offline. `--live` runs five synthetic fixtures against the configured provider, with at most one model call per fixture, and refuses to start unless `AEQUITAS_CASE_AGENT_EVAL_APPROVED=true`, which the operator sets after confirming the provider's data terms and spending limit. It also enforces the provider terms and Gemini billing gates above. It writes only to the `_test` database and a temporary local evidence directory, and suppresses outbound email.

- **Fixtures:** routine English; a routine dispute with a French-speaking complainant and English-speaking respondent; prompt injection with an English-speaking complainant and French-speaking respondent; a question needing legal interpretation; and private-detail bait with the parties using different languages.
- **Recorded per run:** provider, model, prompt version, model-call count, latency, prompt and response character counts, status, expected disposition, escalation reason, both issued outcomes, each party's fixed-text language, and whether each outcome cites only that party's own evidence. Provider-reported input, output and total token counts are summed only when the provider reported that field for every call. Missing or partial usage is identified; billed-currency cost is not available in this interface and must be checked in the provider's billing account.
- **Results so far:** only the stub mode has been run (5/5, which proves the harness works, not model quality). **Live-model quality is untested.**

## Known limits

- **Test coverage:**
  - A stub stands in for the respondent's passkey enrolment.
  - Scanning in the routine integration tests is seeded; the browser test uploads through the real scanner in CI.
  - Page-number citation is verified end to end for searchable and OCR-extracted scanned multi-page PDFs.
- **Heuristic checks.** The deny list catches forbidden phrasing in staff-only model text; it cannot prove that text is accurate or neutral.
- **Escalation behaviour:**
  - Any model failure escalates at once; there is no retry budget.
  - The automated respondent invitation expires with the configured response period. Invitation and account-recovery emails remain outside the retry outbox.
- **Scope:**
  - One program per deployment. Roles are global, so this is not multi-organization software.
  - Two parties only. No retention or deletion service.

## Decisions still needed before real case data

**Owner**
- **Approval waiver.** Decide whether to keep the default independent approver sign-off or explicitly waive it for routine agent-managed cases. The waiver is now a separate required program setting; enabling the agent alone does not waive it. Phase 3 introduced approver sign-off as an independent check.
- **Remedies and limits.** Confirm the remedy list, the amount limit, the intake and response periods, and the respondent-withdrawal rule for the program.
- **Accountability and oversight.** Who answers for agent proposals, how often staff sample them, the complaint process, and the human-review capacity needed to absorb escalations.

**Operator**
- **Provider.** Choose a provider and account. Review its current data-use, retention and region terms; free tiers may differ from paid ones.
- **Spending and monitoring.** Set spending limits and monitoring.
- **Scheduling.** Schedule `agent:run` and `notify:deliver`.
- **Live evaluation.** Run it on synthetic cases before any real use.

**Counsel** (not assessed here)
- **Automated processing.** Obligations for proposals produced without a person, under Québec privacy law, including notice and the right to have a person review.
- **Privacy and transfers.** Whether sending both parties' submissions to the provider, possibly outside Québec, needs a privacy impact assessment and transfer analysis.
- **Mediation framework.** How the agent fits any mediation or dispute-resolution framework that applies to the program.
- **Retention.** Retention and deletion periods, given the append-only event log.
- **Wording.** Adequacy of the bilingual notices and proposal wording.
