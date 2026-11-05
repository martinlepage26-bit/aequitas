# Paid pilot readiness (updated 2026-11-05)

Status: **release candidate for review. Not approved for real pilot data.** This page records hypotheses, what the code supports, and the gates that remain. It is not market validation, legal advice, privacy approval or a production-readiness claim.

## Release base

- **Public host observed 2026-11-05:** a read-only request to [the public site](https://aequitas.app.pharos-ai.ca/) returned HTTP 200. Its [health endpoint](https://aequitas.app.pharos-ai.ca/api/health) returned `status: ok` and release SHA `d74ed342693a96a6dc75d8907d288131c0148385`. GitHub does not resolve that SHA in `martinlepage26-bit/aequitas`, and the local repository has no object for it; the deployed source and commit provenance remain unverified.
- **Public copy is behind this candidate.** The live landing page still says a neutral case manager reviews proposals and that proposals are reviewed by a person. It does not describe the optional autonomous routine path in PR 14. This is evidence about the public page only; it does not establish agent settings or worker state on the host.
- **Historical deployment records still conflict.** The 2026-10-15/16 `docs/ct920-standup.md` names CT920 release `2160eaf` behind a Cloudflare Worker, with Railway's app stopped. An older section of `docs/SPEC.md` says no cutover happened. Treat those records as historical; the health SHA above is not mapped to source.
- `2160eaf` is an ancestor of `ct920-standup` (PR 13), not of `main`. `main` is the older line (phase 3 plus three docs commits).
- The 2026-10-21 local snapshot (per-party outcomes, consent bound to the outcome version, party isolation) differs from `ct920-standup` head `34a00e0` in 59 paths only. It is imported as one commit.
- **Candidate = `ct920-standup` + snapshot + this pilot work**, reviewed as PR 14 against `ct920-standup`. Nothing targets `main`: PR 13 states that merging to `main` auto-deploys to Railway. PR 14 is still a draft and has not been merged or deployed.

## Buyer (hypothesis, not validated demand)

One Québec program that runs voluntary consumer dispute resolution between a buyer and a seller. The proposed agent handles eligible routine `RETAIL` cases; program staff take exceptions and cases outside scope. No customer conversation, letter of intent or pricing evidence is in this repository.

## Workflow problem (hypothesis)

Staff assemble each file from email, attachments and phone notes. Parties cannot see a dated record of what they submitted, and the written proposal is hard to trace to evidence. Consent is not tied to a specific version of what the party read.

## Proposed pilot offer

- One program, one isolated deployment, `RETAIL`, two-party cases, fr-CA and en-CA.
- The agent handles the configured routine path without a case manager. Each party sees fixed bilingual proposal wording, can consent or decline, can ask for a person, and keeps control over their own evidence and outcome. Independent approver sign-off remains required unless the program explicitly enables consent-only resolution after owner and governance approval.
- Program staff remain available for every exception, request for review, decline, or case outside scope. Human-managed cases retain the separate approver step.
- The agent remains off until the program rules, provider account and data terms, oversight, privacy/legal review, and live synthetic evaluation are resolved. No AI call is enabled by default.
- Price, term and payment: **not set.** No billing is built.

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
- Invitation and account-recovery emails are sent directly (`src/lib/mail.ts`), not through the retried outbox.
- Storage cleanup after a crashed write is manual.
