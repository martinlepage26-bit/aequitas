# Private synthetic baseline review

**Status:** instructions only. No human reference review or provider-terms acceptance has been recorded. The public fixture examples in the repository are for offline CI and cannot establish an independent live baseline.

## Prepare a private, unpublished fixture set

Live mode now requires a new seven-case synthetic fixture set stored outside the repository in a file owned by the current user with owner-only permissions (normally `0600`). The set must use the schema `aequitas.case-agent-private-fixtures.v1`, set `syntheticOnly` and `unpublished` to `true`, and use opaque names `private-a` through `private-g`. Do not include real personal information.

Create a reviewer packet from that set before any model output:

```sh
npm run agent:blind-packet -- --fixtures-file=/private/path/fixtures.json --out=/private/path/blind-packet.md
```

The generated packet contains the complete synthetic inputs, exact model identity and workflow policy, but omits internal fixture names and expected dispositions, escalation reasons, and model-call counts. Give reviewers only this generated packet and their relevant review form. Do not send them the private fixture JSON, source code, public examples, or any model output before the reference is frozen.

## Independent review required

- A qualified program case reviewer assesses all seven cases and records supportable facts, source submissions, counterevidence, unknowns, privacy limits, and an independent proposal-or-handoff disposition.
- Qualified counsel assesses cases that raise a legal question and confirms the agent must not provide legal interpretation.
- A qualified Québec French reviewer assesses every case with an `fr-CA` party, including notices, handoffs, clarity, and party-specific privacy.
- Resolve disagreements before freezing the reference. If a reviewer rejects an expected disposition or its basis, revise the private fixture set and review again. Do not force an answer to match the code.
- Record reviewer names, roles, qualification bases, and UTC review times in the private review file. One person may hold multiple roles only when qualified and each role is separately recorded.
- For each role, record that the reviewer is independent of Aequitas development, has not seen the public benchmark answers before this review, and has declared conflicts of interest. A reviewer who has seen those answers cannot provide an independent baseline for this run.

After the reviewers complete their independent work, create and complete the owner-private structured form:

```sh
npm run agent:baseline-template -- --fixtures-file=/private/path/fixtures.json --out=/private/path/baseline-review.json
npm run agent:validate-baseline -- --fixtures-file=/private/path/fixtures.json --file=/private/path/baseline-review.json
```

The form binds the review to the exact provider, model, workflow policy, prompt, protocol, and private fixture-set digest. Validation checks structure, dates, required roles, fixture identity, file permissions, recorded dispositions, and per-role independence, prior-answer-exposure, and conflict declarations. These are recorded attestations: validation cannot verify reviewer identity, qualifications, the truth of those declarations, or the quality of their judgment.

## Selected synthetic target and spend boundary

Martin selected Cloudflare Workers AI account `1713c51cc6fbcf8d7143526b93495b76`, model `@cf/google/gemma-4-26b-a4b-it`, for synthetic-only evaluation and set a maximum run authorization of **US$0.11**. The evaluator estimates a worst-case request-bound cost of about US$0.103 and refuses if the estimate exceeds the explicit single-run amount. This local guard does not cap unrelated or concurrent account activity; Cloudflare billing remains authoritative. Acceptance of the account's applicable terms and settings is still required before a provider request.

The account token must be scoped and configured locally. Never put credentials or private reviewer notes in chat, Git, a public packet, or a tracked environment file. After the frozen review and account-terms check, the operator can authorize one bounded command with `--authorize-single-live-synthetic-run=0.11`. The evaluator still stops unless every identity-bound gate passes.
