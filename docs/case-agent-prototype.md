# Case agent prototype (2026-11-05)

Status: **prototype, off by default, tested on synthetic data only.** It is not part of the paid-pilot offer in `docs/paid-pilot-readiness.md`. Do not enable it for real cases before the decisions at the end of this page are made.

## What it does

For one Québec program's `RETAIL` cases, the assigned manager still opens intake, records the conflict-of-interest declaration, and opts the case in. The agent then manages the remaining routine steps for parties who participate:

1. **Manages evidence-intake completion.** Each party decides when their own evidence and dated entries are complete. A party can clear that mark while intake remains open; any new evidence or chronology entry clears that party's mark, and a material case-detail correction clears both marks. The agent closes intake only after both parties mark complete and both have current clean evidence. It queues a bilingual email to each party asking them to submit or update their position. A scan failure, open contestation, out-of-scope case, or evidence limit sends the case to a person. Silence never closes intake; there is no deadline or automatic non-response rule.
2. **Checks the file.** After both parties submit positions, it waits while a position is missing or a scan is pending. The case goes to a person if:
   - the category is not `RETAIL`
   - the amount is missing or above the program's limit, or no limit is configured
   - a file failed scanning
   - a party has no clean evidence
   - a contestation is open

   No model is called until these checks pass.
3. **Asks the configured model** for a neutral summary with citations to case evidence, and for one non-binding proposed outcome per party, written in that party's language.
4. **Validates the reply deterministically** (`src/domain/caseAgent/output.ts`). The case goes to a person instead if any check fails. The reply must:
   - follow a strict JSON shape, with no model-set reviewer or source fields
   - cite only current clean evidence in the case, each item at most once, with an exact excerpt from the hash-verified extraction
   - attach server-computed character offsets plus the source-file and extracted-text hashes for every citation
   - have each party's outcome cite only that party's own evidence
   - not repeat any six-word run from the other party's submissions in a party's outcome
   - avoid the forbidden terms and score patterns
   - not judge credibility, state what the law requires, use binding wording, or apply deadline pressure (English and French)
5. **Issues** in one locked write (`agent_issue`): the recommendation (shared text withheld from parties by the existing isolation rule), both party outcomes, their outcome-version-specific citation pointers, and notifications. Each party can open the exact cited excerpt from their own evidence; the server re-extracts it and checks the source hash, extraction hash, and character range before returning it. The excerpt is not copied into a second database field. Parties see the evidence title and excerpt, while model-written citation rationale stays in the staff audit record because the model saw both parties' material. Citation digests are bound to the issuance events and checked by `verifyCase`. If a case-scope field, party language, position, evidence item, scan status, or chronology entry changes during the model call, the result is discarded ("stale") and the next pass starts over.
6. **Records answers** through the existing consent flow, which binds consent to the outcome version. While the agent manages the case, both consents resolve it without approver sign-off.
7. **Closes** (`agent_close`, with a sealed export) only after both parties consent or the complainant withdraws.
8. **Hands the case back** to the assigned case manager if a party declines. It does not close declined cases.

Either party can press **"Ask for a person to review this case"** at any time before closure. The agent then stops, the assigned manager is notified, and approver sign-off applies again. Before the agent issues, a party can still correct their position; a correction during the model call makes that result stale. After issuance, a correction goes through a request for a person.

## Permissions

- **Its own account.** The agent acts as a single `CASE_AGENT` service account, created by `npm run agent:provision`.
- **No sign-in.** No session is ever issued for that role (`src/lib/session.ts` accepts only the four human roles), and it has no passkey.
- **Three transitions only.** In the state machine it holds `agent_close_intake` (EVIDENCE_INTAKE → POSITIONS, after both parties mark ready), `agent_issue` (POSITIONS → ISSUED), and `agent_close` (RESOLVED_CONSENT or WITHDRAWN → CLOSED). A unit test asserts it holds nothing else.
- **Every write is guarded.** Each step checks `agentMayAct`: the case is opted in, not escalated, and the actor is the agent.
- **No case read access.** `caseReadAccess` returns nothing for it, so it cannot use party, manager, approver or admin routes. Tests confirm it cannot consent, approve, write outcomes, issue as a manager, close as a manager, or request a person.
- **Start gate is human; intake completion is party-controlled.** A case manager must open intake, record the conflict-of-interest declaration, and opt the case in. Only each party can mark or clear their own intake-ready status. The agent does not invite a respondent; the complainant must confirm the exact recipient email before an invitation is sent. The assigned manager stays accountable and receives every escalation.
- **Audit and integrity.** Every agent write appends hash-chained events attributed to the agent account, with origin `case_agent`, the model id, the prompt version and a digest of the material it saw. Replay and `verifyCase` pass on agent-closed cases.
- **Evidence input.** The agent downloads current clean evidence, verifies its stored size and SHA-256, then extracts text from UTF-8, PDFs and supported images. PDF pages with no extractable text are rendered one at a time at bounded resolution and OCRed; a mixed PDF keeps its text layer and fills pages that are otherwise blank. It follows the caps of 25 MiB per file, 20 PDF pages, 12,000 characters per source, 12 files and 60,000 characters per case, with a 90-second total OCR limit and a 16 MiB rendered-page limit. If any current evidence is empty, truncated, unsupported, unavailable, over the case limit or fails its integrity check, the model is not called and the case is handed to a person. OCR can misread text; exact excerpts prove only that matching text exists in the extraction, not that the document is authentic, accurate or relevant. A scanned image embedded on a page that also has a text layer may be omitted from OCR.

## Runtime provider and configuration

The agent reuses the existing provider interface (`TextCompletion`, `src/domain/pipeline/provider.ts`): Gemini or Cloudflare Workers AI. Anthropic and OpenAI are refused on this path. Model calls are made and billed by the deployment's own provider account. **Claude Code Cloud credits do not pay for them.**

| Setting | Purpose |
|---|---|
| `AEQUITAS_CASE_AGENT_ENABLED=true` | Turns the agent on. Unset means off. |
| `AEQUITAS_CASE_AGENT_MAX_AMOUNT_CENTS` | The program's amount limit in CAD cents. Unset means no case is in scope. No default is chosen here. |
| `AEQUITAS_PIPELINE_PROVIDER` | `gemini` (default) or `workers-ai`. |
| `GEMINI_API_KEY`, optional `GEMINI_MODEL` | For Gemini. |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, optional `AEQUITAS_WORKERS_AI_MODEL` | For Workers AI. |
| `AEQUITAS_AI_PROVIDER_TERMS_REVIEWED=true` | Required before any live case data is sent. Set only after reviewing the current terms for the selected provider, account and model; this is not legal or privacy approval. |
| `AEQUITAS_GEMINI_PAID_TIER_CONFIRMED=true` | Also required for Gemini. Confirm the exact API key belongs to a project with active billing. Gemini's unpaid tier is unsuitable for case data under Google's current terms; the app cannot inspect the key's billing tier. |
| `npm run agent:provision` | Creates the service account once. |
| `npm run agent:run` | One scheduled pass. The CT920 `scheduled` Compose profile runs it every 10 minutes alongside notification retries every 15 minutes. Start that profile explicitly after deployment; it is not part of the default web stack. Enrollment is refused unless the selected provider is configured; if a provider is later missing, the pass skips all cases without changing them. Each case is compare-and-set leased before processing, revisited no sooner than 10 minutes later, and released afterward; an expired 30-minute lease recovers after a crashed run. It prints counts only. |

Start the production scheduler from `deploy/ct920` with `RELEASE_SHA="$(git -C ../.. rev-parse HEAD)" docker compose -p aeq-prod --profile scheduled up -d scheduler`. The worker receives database, event-chain, storage, mail and approved provider settings; it does not receive the web session or WebAuthn secrets. Check counts with `docker compose -p aeq-prod --profile scheduled logs scheduler`. The agent remains off unless `AEQUITAS_CASE_AGENT_ENABLED=true` and the provider gates above are configured.

Not verified here: any live provider call, output quality on real disputes, latency and cost. Tests use a local stub.

Provider terms checked 2026-11-05: Google's Gemini API Additional Terms say Unpaid Services may use prompts and responses to improve products, may involve human review, and must not receive sensitive, confidential or personal information. Paid Gemini API use requires an active billing project and has different data terms. Cloudflare says standard Workers AI inference has zero retention and no model training, subject to stated exceptions; third-party model licenses still apply. These runtime flags do not assess Québec privacy law, transfers, or whether the provider is suitable for a specific program. See the [Gemini terms](https://ai.google.dev/gemini-api/terms), [Gemini billing tiers](https://ai.google.dev/gemini-api/docs/billing), and [Cloudflare Workers AI data-use terms](https://developers.cloudflare.com/workers-ai/platform/data-usage/).

## Synthetic provider check

`npm run agent:evaluate` makes at most one request with a fixed, adversarial synthetic retail example. It imports no database or storage code, writes no result, and requires both `AEQUITAS_CASE_AGENT_EVAL_SYNTHETIC_ONLY=true` and an explicit `AEQUITAS_CASE_AGENT_EVAL_PROVIDER=gemini|workers-ai`. Configure that provider's account key separately; the request is billed to that provider account, not Claude Code Cloud credits. The report includes the sample output for human review and deterministic-check result, but does not assess language quality, factual accuracy or neutrality. It is an evaluation aid, not a launch approval.

Example: `AEQUITAS_CASE_AGENT_EVAL_SYNTHETIC_ONLY=true AEQUITAS_CASE_AGENT_EVAL_PROVIDER=gemini npm run agent:evaluate`. Without the confirmation flag, provider choice or provider key, it exits before sending a request.

## Known limits

- The model sees extracted text from the parties' clean evidence. Text from both parties is sent in one provider call; exact-quote checks and six-word overlap checks do not prove that an outcome is neutral or free from paraphrased information about the other party.
- The output checks are heuristics. They cannot prove that free text is accurate, neutral or free of the other party's information. Paraphrase that avoids a six-word overlap would pass.
- A matching excerpt proves traceability to machine-extracted text, not truth, relevance, authenticity, completeness or legal liability. OCR and PDF text may be wrong; the original must be reviewed when a case is handed to a person.
- An issued citation may become unavailable if its source is replaced or fails integrity checks; the original evidence remains the source of record.
- Any model failure escalates at once; there is no retry budget.
- There is no deadline or automated non-response path. If a party never marks their intake complete or submits a position, the agent waits until a person or that party takes another action.
- The complainant, not the agent, confirms the respondent's exact email address before the invitation is sent.
- Only the complainant can withdraw (existing rule); the respondent's equivalent is to decline or ask for a person.
- If the assigned manager drafts by hand on an opted-in case, the agent waits rather than taking over.
- A failure between export generation and closure can leave an extra export bundle.
- Two parties only. No multi-organization isolation.

## Decisions required before real case data

**Product and governance (Martin)**
- **Approval waiver.** Waiving approver sign-off for agent-managed cases removes the independent human check that Phase 3 added. Confirm that party consent plus the right to ask for a person is an acceptable substitute, or keep approver sign-off for agent cases.
- **Accountability.** Who at the program answers for agent-issued proposals, and how often they sample them.
- **Escalation of declined cases.** Whether they should go to a person (current behaviour) or close.

**Runtime (operator)**
- **Provider and account.** Which provider and account to use.
- **Data terms and region.** The provider's data-use and retention terms. Free tiers in particular may differ from paid terms; read the current terms before choosing.
- **Spend and schedule.** Spend limits and monitoring for the scheduled run.

**Legal (counsel; not assessed here)**
- **Automated processing.** Whether proposals produced by automated processing, without a person in the loop, trigger notice or review obligations under Québec privacy law, and what wording the notice must use.
- **Privacy assessment and transfer.** Whether sending both parties' submissions to an external model provider (possibly outside Québec) needs a privacy impact assessment and a transfer assessment.
- **Party-facing wording.** Whether the bilingual notices adequately say that a proposal is not binding, is not legal advice and does not judge truthfulness.
- **Retention.** Retention of prompts and model replies at the provider and in Aequitas.
