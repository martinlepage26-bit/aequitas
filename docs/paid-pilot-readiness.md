# Paid pilot readiness (updated 2026-11-05)

Status: **release candidate for review. Not approved for real pilot data.** This page records hypotheses, what the code supports, and the gates that remain. It is not market validation, legal advice, privacy approval or a production-readiness claim.

## Release base

- **Production commit: unverified.** The last repository record (2026-10-15/16, `docs/ct920-standup.md`) names CT920 release `2160eaf` behind a Cloudflare Worker, with Railway's app stopped. An older section of `docs/SPEC.md` says no cutover happened. Neither can be confirmed from the repository; `2160eaf` is historical evidence only.
- `2160eaf` is an ancestor of `ct920-standup` (PR 13), not of `main`. `main` is the older line (phase 3 plus three docs commits).
- The 2026-10-21 local snapshot (per-party outcomes, consent bound to the outcome version, party isolation) differs from `ct920-standup` head `34a00e0` in 59 paths only. It is imported as one commit.
- **Candidate = `ct920-standup` + snapshot + this pilot work**, reviewed as PR 14 against `ct920-standup`. Nothing targets `main`: PR 13 states that merging to `main` auto-deploys to Railway.

## Buyer (hypothesis, not validated demand)

One Québec program that runs voluntary consumer dispute resolution between a buyer and a seller, with its own staff as case managers. Category: `RETAIL`. No customer conversation, letter of intent or pricing evidence is in this repository.

## Workflow problem (hypothesis)

Staff assemble each file from email, attachments and phone notes. Parties cannot see a dated record of what they submitted, and the written proposal is hard to trace to evidence. Consent is not tied to a specific version of what the party read.

## Proposed pilot offer

- One program, one isolated deployment, `RETAIL`, two-party cases, fr-CA and en-CA.
- Program staff are case managers; one other staff account holds approver sign-off.
- **No AI.** The assigned case manager writes the recommendation, citing at least one clean evidence item from the case. Each party then receives their own written outcome and answers it. Leave `ANTHROPIC_API_KEY` and the pipeline flag unset.
- Price, term and payment: **not set.** No billing is built.

## One measurable outcome

Median elapsed time from `EVIDENCE_INTAKE_OPENED` to `RECOMMENDATION_ISSUED`, read from the event log, against the program's own pre-pilot figure for comparable files. The program supplies the baseline. No target is set here.

## What works end to end (synthetic data, disposable database)

Submission → evidence (scanned) → chronology and positions → case manager writes the recommendation with evidence citations (no model call) → issue checklist → per-party outcomes, each visible only to that party → independent approver sign-off (assigned manager and admin refused) → explicit consent bound to the party's outcome version (a re-issued outcome revokes earlier consent) → export → closure → event hash chain and replay verified. Covered by `test/integration/authored-draft.test.ts` and, in both locales through the browser, `e2e/authored-draft.spec.ts`.

## Onboarding steps

1. Martin chooses the release commit and deploys it to the single pilot host. Not done here.
2. Run `npx prisma migrate deploy` (adds `20261105090000_notification_delivery_attempts`, additive).
3. Invite the program's case managers (`/admin/invites` or `scripts/issue-invite.ts`); each enrols a passkey on the production hostname.
4. Grant approver to one staff member who will not manage the same cases (`scripts/grant-approver.ts`).
5. Publish current consent statements in fr-CA and en-CA.
6. Start the CT920 scheduled profile so failed email notifications are retried every 15 minutes; each is tried at most 8 times, then counted as `exhausted`. The case-agent job also runs every 10 minutes but remains off unless separately enabled after its provider and governance gates are resolved.
7. Set `AEQUITAS_PILOT_CONTACT_URL` at build time if the landing page should show the pilot contact.
8. Run one synthetic case end to end with program staff before any real file.

## Case agent prototype

An opt-in automated case agent exists on this branch (`docs/case-agent-prototype.md`). It is off by default, is not part of this offer, and needs the product, runtime and legal decisions listed there before any real case.

## Launch gates (policy or manual; not decided in code)

1. **Release and hosting decision.** Confirm the deployed commit and host, and choose the pilot deployment. Merging into `main` may trigger Railway.
2. **Retention and deletion policy.** No retention or deletion service exists. Events are append-only by database trigger, so erasure needs a design (for example, separating personal fields from the hash chain). Retention periods and the response to a deletion request need counsel and the program; none are set here.
3. **Privacy assessment.** Whether any processing (hosting, email provider, backups off-box, any later model use) needs a privacy impact assessment or transfer analysis is a question for counsel. Not assessed.
4. **Organization isolation.** Roles are global; any case manager sees unclaimed open cases; admins are global. Multi-organization use is blocked. One program per deployment.
5. **Identity and access.** Real passkey enrolment on the production hostname; identity check before re-enrolling the six existing users.
6. **Email.** Delivery through the configured provider and the retry job must be checked on the pilot host.
7. **Party-facing wording.** Legal review of consent statements, outcome text guidance and the notice that withholds the shared recommendation.
8. **Commercial.** Pricing, contract, data processing terms.

## Known defects and limits

- Two parties only. No translation-review workflow.
- Invitation and account-recovery emails are sent directly (`src/lib/mail.ts`), not through the retried outbox.
- Storage cleanup after a crashed write is manual.
