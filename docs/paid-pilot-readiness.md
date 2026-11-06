# Paid pilot readiness (updated 2026-11-06)

Status: **release candidate for review. Not approved for real pilot data.** This page records hypotheses, what the code supports, and the gates that remain. It is not market validation, legal advice, privacy approval or a production-readiness claim.

## Release base

- **Public host rechecked 2026-11-06:** read-only GETs to [the public site](https://aequitas.app.pharos-ai.ca/) and its [health endpoint](https://aequitas.app.pharos-ai.ca/api/health) returned HTTP 200; health reported `status: ok` and release SHA `d74ed342693a96a6dc75d8907d288131c0148385`. GitHub does not resolve that SHA in `martinlepage26-bit/aequitas`, and the local repository has no object for it; the deployed source and commit provenance remain unverified. The candidate routes `/fr-CA/demo` and `/en-CA/demo` returned HTTP 404 on the public host, so the walkthrough exists only in the unmerged PR candidate. These checks do not establish agent settings or worker state on the host.
- **Public copy is behind this candidate.** The live landing page still describes a neutral case manager reviewing proposals and says proposals are reviewed by a person. It does not describe the optional autonomous routine path in PR 14. This is evidence about the public page only; it does not establish agent settings or worker state on the host.
- **Historical deployment records still conflict.** The 2026-10-15/16 `docs/ct920-standup.md` names CT920 release `2160eaf` behind a Cloudflare Worker, with Railway's app stopped. An older section of `docs/SPEC.md` says no cutover happened. Treat those records as historical; the health SHA above is not mapped to source.
- `2160eaf` is an ancestor of `ct920-standup` (PR 13), not of `main`. `main` is the older line (phase 3 plus three docs commits).
- The 2026-10-21 local snapshot (per-party outcomes, consent bound to the outcome version, party isolation) differs from `ct920-standup` head `34a00e0` in 59 paths only. It is imported as one commit.
- **Candidate = `ct920-standup` + snapshot + this pilot work**, reviewed as PR 14 against `ct920-standup`. Nothing targets `main`: PR 13 states that merging to `main` auto-deploys to Railway. PR 14 is still a draft and has not been merged or deployed.

## Buyer (hypothesis, not validated demand)

A Québec organization that runs voluntary consumer dispute resolution between a buyer and a seller. The proposed agent handles eligible routine `RETAIL` cases; program staff take exceptions and cases outside scope. No customer conversation, letter of intent or pricing evidence is in this repository.

**Competitive evidence checked 2026-11-05 (public sources only):**

- The Office de la protection du consommateur describes PARLe as a free online negotiation service for consumers and participating merchants, with access to an accredited external mediator when needed. Its merchant page reports several hundred participating merchants, about three quarters of files ending in agreement, an average duration of about five weeks, and 82% overall satisfaction. These are OPC-published service figures, not an independent comparison with Aequitas ([OPC: PARLe for merchants](https://www.opc.gouv.qc.ca/parle-commercant)).
- The OPC's 2024–2025 annual report records 1,844 agreements on PARLe during that fiscal year. It also reports survey results for the value of settled disputes; those figures do not establish a market size or willingness to pay for Aequitas ([OPC: 2024–2025 annual report](https://cdn.opc.gouv.qc.ca/media/documents/a-propos/publication/RAG_2024-2025.pdf)).
- A Québec government project dashboard, updated 2026-10-01, lists an active Justice-sector online dispute resolution platform for disputes within the jurisdiction of the Court of Québec's Small Claims Division. The dashboard shows 45% progress, an estimated cost of $8,682,100, and an estimated end date of 2028-01-18 ([Québec project dashboard](https://www.tableaudebordprojetsri.gouv.qc.ca/tableau-de-bord/projet/29637912)). This is a material adjacent initiative; the public record does not establish its procurement needs, technical design, or whether it will cover Aequitas's exact routine workflow.

**Opportunity ranking checked 2026-11-06 (public evidence only; no demand validation):**

1. **An independent dispute-resolution program with a documented retail queue outside existing services — best fit to test, low evidence.** Its routine two-party files most closely match the product, and an operator could be the buyer while both parties remain free. No named organization, unmet workflow, case volume, software budget, or willingness to pilot is evidenced here. The segment remains a hypothesis, not a lead or market-size claim.
2. **BBB's national or regional complaint-handling operation — identifiable but not an evident gap.** BBB already takes marketplace disputes through an online complaint process, asks businesses to respond within 10–15 days, generally closes complaints within about 30 days, and may offer mediation or arbitration depending on region. The Better Business Bureau of Canada’s Northern Capital Regions and Quebec was expelled from the BBB system in June 2024; BBB says the region continues to receive service from other member BBBs and that inquiries are handled across North America. This is a possible operator conversation only if it reveals an unmet internal workflow; the published process is not evidence that BBB needs Aequitas ([BBB complaint process](https://www.bbb.org/process-of-complaints-and-reviews/complaints), [BBB dispute handling](https://www.bbb.org/about/bbb-dispute-handling-and-resolution), [BBB Quebec service change](https://www.bbb.org/article/news-releases/30453-international-association-of-better-business-bureaus-expels-member-bbb)).
3. **OPC/PARLe or Québec's public ODR work — strong topical overlap, weak first-customer fit.** PARLe is a free, private online negotiation platform for consumers and participating merchants; parties can upload evidence and use an accredited mediator if needed. The OPC also says it cannot intervene in every reported situation and leaves consumers responsible for negotiating. That establishes both a close free alternative and a possible service gap, but not a separate funded buyer, unmet volume, or procurement path. Do not pitch Aequitas as a replacement for PARLe or the government's active small-claims ODR project ([OPC on PARLe](https://www.opc.gouv.qc.ca/en/consommateur/probleme-commercant/ressources/parle-consommation), [OPC complaint role](https://www.opc.gouv.qc.ca/en/consumer/resolve-problem/steps), [Québec ODR project](https://www.tableaudebordprojetsri.gouv.qc.ca/tableau-de-bord/projet/29637912)).
4. **Sector complaint bodies — exclude from the retail MVP.** CCTS handles telecom and television complaints; AMF's complaint and mediation path is for financial-sector matters. These show that some Canadian redress programs are mandate-specific, not evidence that either body is a buyer for Aequitas's retail product ([CCTS mandate](https://www.ccts-cprst.ca/for-consumers/faq/), [AMF complaint process](https://lautorite.qc.ca/en/general-public/assistance-and-complaints/making-a-complaint)).
5. **A single merchant or marketplace as payer — low priority until neutrality is proven.** The product's fairness promise depends on both parties trusting the process. One party funding the service could create a perceived conflict; this is a product-governance concern, not evidence about buyer demand.

**Commercial implication:** do not pitch Aequitas as a replacement for PARLe or assume the OPC is a buyer. The research narrows, but does not validate, the hypothesis that an independent program has an uncovered routine retail queue and would pay for this workflow. Before pricing or making differentiator claims, speak with operators: review recent files and current tools, quantify eligible volume and staff effort, identify the budget/procurement owner, understand why existing services do not fit, and confirm both parties' trust and required safeguards. A stated interest is not purchase evidence; seek a named budget owner and written next step.

**Initial discovery guide (3–5 operator interviews; directional, not statistically representative):**

- Walk through the last three routine retail cases from intake to closure. Where did each case wait, need staff time, or leave the parties uncertain?
- Which cases are already handled by PARLe, a sector service, an internal process, or small claims? What cases are left out, and how often?
- Roughly how many cases per year fit Aequitas's narrow `RETAIL`, two-party, configured-limit path? What share would be escalated under the current rules?
- What tools hold the case narrative, evidence, party messages, decisions, and audit history today? What does staff spend per file in minutes or cost?
- Who owns the workflow, software budget and procurement decision? What current budget line could pay for a pilot, and which security/privacy review is required?
- What independent review, party notice, appeal, retention and privacy safeguards would be mandatory before using a non-binding machine-generated proposal?
- If the workflow gap and safeguards are credible, what specific next step could the organization commit to (for example, a named budget-owner meeting or a written evaluation plan)?

Do not collect case files, party identifiers, or confidential operational details for this discovery. Record who answered each question, whether a number is observed or estimated, the supporting source, and what remains unknown. An expression of interest without an identified workflow, budget owner and concrete next step does not validate demand.

## Workflow problem (hypothesis)

Staff assemble each file from email, attachments and phone notes. Parties cannot see a dated record of what they submitted, and the written proposal is hard to trace to evidence. Consent is not tied to a specific version of what the party read.

## Proposed pilot offer

- One program, one isolated deployment, `RETAIL`, two-party cases, fr-CA and en-CA.
- The agent handles the configured routine path without a case manager. Each party sees fixed bilingual proposal wording, can consent or decline, can ask for a person, and keeps control over their own evidence and outcome. Independent approver sign-off remains required unless the program explicitly enables consent-only resolution after owner and governance approval.
- Program staff remain available for every exception, request for review, decline, or case outside scope. Human-managed cases retain the separate approver step.
- The agent remains off until the program rules, provider account and data terms, oversight, privacy/legal review, and live synthetic evaluation are resolved. No AI call is enabled by default.
- Price, term and payment: **not set.** No billing is built.

## Commercial packaging and price logic (internal hypothesis; no price approved)

**Buyer and payer hypothesis:** an independent dispute-resolution program or member organization with a documented routine retail case queue that its current service does not handle. The program pays; neither party to the dispute pays a fee to use Aequitas. This is a positioning hypothesis, not validated demand. Québec already offers PARLe as a free consumer–merchant negotiation service, and a government small-claims ODR platform is active, so the first prospect should be outside those covered workflows rather than pitched as their replacement ([OPC PARLe](https://www.opc.gouv.qc.ca/en/parle-commercant/), [Québec ODR project dashboard](https://www.tableaudebordprojetsri.gouv.qc.ca/tableau-de-bord/projet/29637912)). A Canadian analogue, OBSI, provides consumer dispute resolution free to consumers while participating firms fund the service under regulatory requirements and independence safeguards; that supports the payer model as an analogy, not as a direct price comparison ([OBSI funding model](https://www.obsi.ca/en/for-consumers/how-were-funded/)).

**SKU 1 — paid pilot:** one program, one isolated deployment, bilingual fr-CA/en-CA, two-party retail cases, configured eligibility limits, staff onboarding, and a time-limited evaluation with an agreed case cap and service measures. The owner, operator and counsel gates still apply; no real case data enters the pilot before those gates are resolved. Quote a fixed implementation fee plus a fixed pilot fee so the buyer can budget the deployment and evaluation. The fee should cover setup, hosting, support, provider usage, and the agreed case volume. No amount is set until discovery establishes the buyer's baseline costs, case volume, support needs, and procurement path.

**SKU 2 — continued service, conditional on pilot evidence:** an annual program licence with an included case-volume band and separately priced managed operations or integrations. Set the volume bands and renewal price from observed usage, hosting/support costs, and the program's own baseline; do not publish a price ladder yet.

**Promise boundary and exclusions:** Aequitas offers workflow software and a non-binding proposal process, not adjudication, legal advice, guaranteed settlement, or a promised reduction in case time. The pilot does not include multiple programs, multi-tenant hosting, custom integrations, legal review, or unlimited human case-management capacity. Do not tie payment to consent, settlement, or the outcome of a dispute.

**Discovery inputs required before quoting:** eligible cases per year; current staff minutes and cost per case; existing software and unresolved workflow; human-review capacity; hosting and support expectations; who controls the budget and procurement; whether both parties trust a program-funded service; and the provider/privacy terms the program will accept. Until these are known, the offer is shaped but not priced.

## One measurable outcome

Median elapsed time from `EVIDENCE_INTAKE_OPENED` to `RECOMMENDATION_ISSUED`, read from the event log, against the program's own pre-pilot figure for comparable files. The program supplies the baseline. No target is set here.

## What works end to end (synthetic data, disposable database)

The manual journey is covered: submission → scanned evidence → positions → case manager writes a cited recommendation without AI → issuance → per-party outcomes → independent approver sign-off → version-bound party consent → export and closure. The autonomous routine path is also covered with synthetic data and a stub model: agent intake → respondent invitation → both parties' evidence and positions → exact evidence citations and fixed remedy wording → both consents → export and closure. Neither journey proves live-model quality or readiness for real cases. See `test/integration/authored-draft.test.ts`, `test/integration/case-agent-routine.test.ts`, and the corresponding browser tests.

## Onboarding steps

1. Martin chooses the release commit and deploys it to the single pilot host. Not done here.
2. Run `npx prisma migrate deploy` to apply all pending schema migrations on the selected release, including the notification-attempt and case-agent scheduler fields.
3. Invite the program's case managers (`/admin/invites` or `scripts/issue-invite.ts`); each enrols a passkey on the production hostname.
4. Grant approver to one staff member who will not manage the same cases (`scripts/grant-approver.ts`).
5. Publish current consent statements in fr-CA and en-CA.
6. Set the program's explicit amount limit, intake and response periods, respondent-withdrawal rule, and consent-only resolution policy. Keep `AEQUITAS_CASE_AGENT_CONSENT_ONLY_RESOLUTION=false` unless the owner explicitly approves waiving independent sign-off. Review the selected provider's current terms; set `AEQUITAS_AI_PROVIDER_TERMS_REVIEWED=true` and, for Gemini, `AEQUITAS_GEMINI_PAID_TIER_CONFIRMED=true` only after verification. Start the CT920 scheduled profile so failed notifications retry every 15 minutes and the case agent runs every 10 minutes. The agent takes no new cases without complete program settings and an approved provider configuration.
7. Set `AEQUITAS_PILOT_CONTACT_URL` at build time if the landing page should show the pilot contact.
8. Run one synthetic case end to end with program staff before any real file.

## Case agent prototype

The automated case agent is the proposed routine workflow, but is off by default. Its program settings have no defaults; it needs the owner, operator and counsel decisions in `docs/case-agent-prototype.md` before any real case.

The public `/fr-CA/demo` and `/en-CA/demo` routes provide a static walkthrough built from invented content and the app's fixed proposal template. They do not call a model or use case data, and are not a live product demonstration.

## Launch gates (policy or manual; not decided in code)

1. **Release and hosting decision.** Confirm the deployed commit and host, and choose the pilot deployment. Merging into `main` may trigger Railway.
2. **Retention and deletion policy.** No retention or deletion service exists. Events are append-only by database trigger, so erasure needs a design (for example, separating personal fields from the hash chain). Retention periods and the response to a deletion request need counsel and the program; none are set here.
3. **Privacy assessment.** Whether hosting, email, backups and sending submissions to the selected model provider need a privacy impact assessment or transfer analysis is a question for counsel. Not assessed.
4. **Organization isolation.** Roles are global; any case manager sees unclaimed open cases; admins are global. Multi-organization use is blocked. One program per deployment.
5. **Identity and access.** Real passkey enrolment on the production hostname; identity check before re-enrolling the six existing users.
6. **Email.** Delivery through the configured provider and the retry job must be checked on the pilot host.
7. **Party-facing wording.** Legal review of consent statements, outcome text guidance and the notice that withholds the shared recommendation.
8. **Commercial.** Pricing, contract, data processing terms.

## Known defects and limits

- Two parties only. No translation-review workflow.
- Invitation emails are sent directly (`src/lib/mail.ts`) with one immediate retry using the same provider idempotency key; if delivery remains uncertain, the active link is preserved and staff must resolve it. Account-recovery emails remain outside the retried outbox.
- Storage cleanup after a crashed write is manual.
