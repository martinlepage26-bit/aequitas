# Paid pilot readiness (2026-11-04)

Status: **not ready for a paid pilot with real case data.** This page records hypotheses and what the code supports. It is not market validation, legal advice or a production-readiness claim.

## Buyer (hypothesis, not validated demand)

One Québec program that runs voluntary consumer dispute resolution between a buyer and a seller, with its own staff acting as case managers. Category: `RETAIL` (supported; default category). No customer conversation, letter of intent or pricing evidence is in this repository.

## Workflow problem (hypothesis)

Staff assemble each file from email, attachments and phone notes. The parties cannot see a shared, dated record of what was submitted, and the written proposal is hard to trace back to evidence. Consent to the proposal is not tied to a specific version.

## Proposed pilot offer

- One program, one category (`RETAIL`), two-party cases only, fr-CA and en-CA.
- Program staff are the case managers. One additional staff account holds approver sign-off (separation of duties is enforced).
- **AI drafting off by default.** The assigned case manager writes the recommendation draft in the workspace (`author_draft`, added in this change). The model path stays available only if the program and operator decide to enable it after a privacy assessment.
- Price, term and payment method: **not set.** No billing is built.

## One measurable outcome

Median elapsed time from `EVIDENCE_INTAKE_OPENED` to `RECOMMENDATION_ISSUED`, read from the case event log, compared with the program's own pre-pilot figure for comparable files. The program supplies its baseline before the pilot starts. No target is set here.

## Onboarding steps

1. Martin confirms which code line is the release (see blocker 1) and deploys it. Not done in this change.
2. Admin issues invitations to the program's case managers (`/admin/invites` or `scripts/issue-invite.ts`). Each enrols a passkey on the production hostname.
3. Grant approver capability to one program staff member who will not manage the same cases (`scripts/grant-approver.ts`). Today Martin is the only approver (P3-D2).
4. Publish current consent statement versions in fr-CA and en-CA.
5. Set `AEQUITAS_PILOT_CONTACT_URL` (https booking page or `mailto:`) at build time so the landing page shows the pilot contact. Unset, the call to action is hidden.
6. Leave `ANTHROPIC_API_KEY` unset unless the program and operator approve model use. Case managers use "Write the draft recommendation yourself".
7. Run one synthetic case end to end with program staff before any real file.

## Verified in this change (synthetic data, disposable database)

- Case manager writes, revises (reason required, prior version kept as SUPERSEDED), and issues a draft with no model call; approver signs off; both parties consent; export generated; case closed; event chain and replay verify. (`test/integration/authored-draft.test.ts`)
- Refusals: parties (403), admin (403), unassigned manager (404), wrong stage (409), empty limits / not-considered, forbidden term, citation to another case's evidence, server-only fields (409). Nothing is written on refusal.
- Browser journey in fr-CA and en-CA: party and unassigned manager refused over HTTP; draft hidden from the party until issued; issued text labelled as written by the case manager with no model. (`e2e/authored-draft.spec.ts`)

## Unresolved blockers

1. **Release line is split.** `main` lacks the 14 commits on `ct920-standup` (open PR 13), which is the line the CT920 production release `2160eaf` came from. A later local snapshot (2026-10-21) adds unpushed work: per-party outcomes, consent bound to a party outcome version, party isolation tests. This change is on `main`; it will need integration with both. Decision needed from Martin.
2. **Hosted state unknown.** The last repository record (2026-10-15/16) says production moved to CT920 behind Cloudflare and Railway's app was stopped. An older spec section says no cutover had happened. Current state cannot be established from the repository. Six existing users still needed identity-verified passkey re-enrolment.
3. **No organization-level data isolation.** Users have global roles; any case manager can see unclaimed open cases; admins are global. **Multi-organization use is blocked.** A pilot must be one program on its own deployment.
4. **Personal information handling not assessed.** No retention/deletion service exists. Whether sending case material to a model provider outside Québec requires a privacy impact assessment has not been assessed (this is a question for counsel, not a conclusion).
5. **Email delivery not verified** in this change; invitations have no background retry scheduler.
6. **Evidence scanning not exercised here.** No ClamAV daemon was available; tests used a loopback stand-in. Native PDF/OCR extraction and S3 storage-rollback suites need their services.
7. **Manual checks required:** real passkey enrolment on the production hostname, email delivery, owner identity verification before re-enrolment, live AI quality (if ever enabled), and legal review of party-facing wording.
8. No pricing, contract, data processing terms or customer evidence.
