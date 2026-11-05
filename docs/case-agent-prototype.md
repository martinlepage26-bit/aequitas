# Case agent prototype (2026-11-05)

Status: **prototype, off by default, tested on synthetic data only.** It is not part of the paid-pilot offer in `docs/paid-pilot-readiness.md`. Do not enable it for real cases before the decisions at the end of this page are made.

## What it does

For one Québec program's `RETAIL` cases, after the assigned case manager closes intake and both parties have submitted positions, the agent does the routine steps a manager would otherwise do by hand:

1. **Checks the file.** It waits while a position is missing or a scan is pending. The case goes to a person if:
   - the category is not `RETAIL`
   - the amount is missing or above the program's limit, or no limit is configured
   - a file failed scanning
   - a party has no clean evidence
   - a contestation is open

   No model is called until these checks pass.
2. **Asks the configured model** for a neutral summary with citations to case evidence, and for one non-binding proposed outcome per party, written in that party's language.
3. **Validates the reply deterministically** (`src/domain/caseAgent/output.ts`). The case goes to a person instead if any check fails. The reply must:
   - follow a strict JSON shape, with no model-set reviewer or source fields
   - cite only current clean evidence in the case, each item at most once
   - have each party's outcome cite only that party's own evidence
   - not repeat any six-word run from the other party's submissions in a party's outcome
   - avoid the forbidden terms and score patterns
   - not judge credibility, state what the law requires, use binding wording, or apply deadline pressure (English and French)
4. **Issues** in one locked write (`agent_issue`): the recommendation (shared text withheld from parties by the existing isolation rule), both party outcomes and notifications. If any position, evidence item, scan status or chronology entry changed during the model call, the result is discarded ("stale") and the next pass starts over.
5. **Records answers** through the existing consent flow, which binds consent to the outcome version. While the agent manages the case, both consents resolve it without approver sign-off.
6. **Closes** (`agent_close`, with a sealed export) only after both parties consent or the complainant withdraws.
7. **Hands the case back** to the assigned case manager if a party declines. It does not close declined cases.

Either party can press **"Ask for a person to review this case"** at any time before closure. The agent then stops, the assigned manager is notified, and approver sign-off applies again. Before the agent issues, a party can still correct their position; a correction during the model call makes that result stale. After issuance, a correction goes through a request for a person.

## Permissions

- **Its own account.** The agent acts as a single `CASE_AGENT` service account, created by `npm run agent:provision`.
- **No sign-in.** No session is ever issued for that role (`src/lib/session.ts` accepts only the four human roles), and it has no passkey.
- **Two transitions only.** In the state machine it holds `agent_issue` (POSITIONS → ISSUED) and `agent_close` (RESOLVED_CONSENT or WITHDRAWN → CLOSED). A unit test asserts it holds nothing else.
- **Every write is guarded.** Each step checks `agentMayAct`: the case is opted in, not escalated, and the actor is the agent.
- **No case read access.** `caseReadAccess` returns nothing for it, so it cannot use party, manager, approver or admin routes. Tests confirm it cannot consent, approve, write outcomes, issue as a manager, close as a manager, or request a person.
- **Opt-in is human.** Only the case's assigned case manager can opt a case in, during intake or positions. That manager stays accountable and receives every escalation.
- **Audit and integrity.** Every agent write appends hash-chained events attributed to the agent account, with origin `case_agent`, the model id, the prompt version and a digest of the material it saw. Replay and `verifyCase` pass on agent-closed cases.

## Runtime provider and configuration

The agent reuses the existing provider interface (`TextCompletion`, `src/domain/pipeline/provider.ts`): Gemini or Cloudflare Workers AI. Anthropic and OpenAI are refused on this path. Model calls are made and billed by the deployment's own provider account. **Claude Code Cloud credits do not pay for them.**

| Setting | Purpose |
|---|---|
| `AEQUITAS_CASE_AGENT_ENABLED=true` | Turns the agent on. Unset means off. |
| `AEQUITAS_CASE_AGENT_MAX_AMOUNT_CENTS` | The program's amount limit in CAD cents. Unset means no case is in scope. No default is chosen here. |
| `AEQUITAS_PIPELINE_PROVIDER` | `gemini` (default) or `workers-ai`. |
| `GEMINI_API_KEY`, optional `GEMINI_MODEL` | For Gemini. |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, optional `AEQUITAS_WORKERS_AI_MODEL` | For Workers AI. |
| `npm run agent:provision` | Creates the service account once. |
| `npm run agent:run` | The scheduled pass, for example every 10 minutes. It prints counts only. |

Not verified here: any live provider call, output quality on real disputes, latency and cost. Tests use a local stub.

## Known limits

- The model sees positions, evidence titles and descriptions, chronology and the dispute description. It does not read evidence file contents.
- The output checks are heuristics. They cannot prove that free text is accurate, neutral or free of the other party's information. Paraphrase that avoids a six-word overlap would pass.
- Any model failure escalates at once; there is no retry budget.
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
