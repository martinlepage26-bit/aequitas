# Workers AI synthetic evaluation: owner review brief

**Status:** account and maximum synthetic-run spend selected; no independent fixture references have been approved, no provider call has been made, and no real-case processing is authorized.

## Selected evaluation target

- Provider: Cloudflare Workers AI.
- Account: `1713c51cc6fbcf8d7143526b93495b76`.
- Model: `@cf/google/gemma-4-26b-a4b-it`.
- Scope: seven new, unpublished synthetic fixtures stored outside this repository.
- Martin's maximum authorization for one synthetic run: **US$0.11**.
- Evaluator's conservative request-bound estimate for the seven fixtures: about **US$0.103**. The guard refuses before database setup if the supplied cap is below its computed bound, and reserves the estimate before each request. It does not cap concurrent or unrelated account use; provider billing is authoritative.

The user-selected account and ceiling do not constitute acceptance of the account's current terms/settings, independent approval of expected fixture answers, counsel review, or approval to process real cases.

## Provider terms and limits

Reviewed from the provider's public documentation on 2026-11-10:

- Cloudflare's [Gemma 4 model page](https://developers.cloudflare.com/workers-ai/models/gemma-4-26b-a4b-it/) lists zero data retention and rates of US$0.10 per million input tokens and US$0.30 per million output tokens. The [Workers AI pricing page](https://developers.cloudflare.com/workers-ai/platform/pricing/) lists the same token rates.
- Cloudflare's [Workers AI data-usage page](https://developers.cloudflare.com/workers-ai/platform/data-usage/) says it does not use Workers AI customer content to train AI models. For ordinary inference without a stateful feature, it says inputs and outputs are not retained after they are no longer needed to process the request and deliver the response. It describes exceptions for legal obligations or commitments and notes that storage, asynchronous features, AI Gateway logging or caching, and application logs can retain content according to their own settings and lifecycles.
- The model page links to Google's [Gemma 4 Apache 2.0 license](https://ai.google.dev/gemma/apache_2).

These public statements do not establish this account's current plan, billing state, remaining allowance, settings, gateway/logging configuration, processing location, or applicable agreement. They are not a Québec privacy assessment or legal opinion. An owner must verify the actual account and accept its applicable terms before a provider request. No real case data may be used in this evaluation.

## Private baseline procedure

1. Store a freshly authored seven-fixture JSON file outside the repository with owner-only permissions (`0600`). It must use schema `aequitas.case-agent-private-fixtures.v1`, contain synthetic and unpublished examples only, and not reuse public examples. Never include real personal information.
2. Create a blind packet before any model output:

   ```sh
   npm run agent:blind-packet -- --fixtures-file=/private/path/fixtures.json --out=/private/path/blind-packet.md
   ```

   The generated packet contains fixture inputs, the workflow policy, and the exact provider/model identity. It omits internal fixture names and expected dispositions, escalation reasons, and call counts. Do not show reviewers the fixture JSON, repository code, historical public protocol, or model output before they freeze their findings.
3. Obtain independent reviews from a qualified program case reviewer for all seven fixtures, qualified counsel for fixtures requiring legal handoff, and a qualified Québec French reviewer for every fixture with an `fr-CA` party. Resolve disagreements before freezing. No reviewer outreach has been sent by this agent.
4. Create and complete the private review form:

   ```sh
   npm run agent:baseline-template -- --fixtures-file=/private/path/fixtures.json --out=/private/path/baseline-review.json
   npm run agent:validate-baseline -- --fixtures-file=/private/path/fixtures.json --file=/private/path/baseline-review.json
   ```

   Validation checks shape, dates, roles, fixture identity, expected workflow references, and file permissions. It cannot prove reviewer identity, competence, independence, or judgment quality. A changed fixture set, program policy, provider/model, prompt, or evaluation protocol requires fresh review.

## Local credentials and bounded invocation

The evaluator pins the provider account and model. At 18:25 UTC on 2026-11-10, this Mac worktree had no `.env.local` and the process environment contained no Cloudflare token or account ID. Configure a scoped `CLOUDFLARE_API_TOKEN` locally in the ignored `.env.local` only when ready; never place it in chat, Git, a tracked example, a review packet, or a commit. The runner writes only to a local `_test` database and temporary evidence storage, suppresses email, and checks all gates before provider resolution or database setup.

Only after the human baseline is independently completed and frozen, and the owner has verified and accepted the account terms/settings, should the owner set `AEQUITAS_CASE_AGENT_BASELINE_REVIEWED_FOR` to the exact identity printed by the private baseline-template command. Then one invocation may be authorized with the selected ceiling:

```sh
npm run agent:evaluate -- --live \
  --fixtures-file=/private/path/fixtures.json \
  --authorize-single-live-synthetic-run=0.11 \
  --baseline-review-file=/private/path/baseline-review.json \
  --review-report=/private/path/evaluation-review.json
```

This explicit flag authorizes only that invocation and is not stored in the environment. A successful machine report still requires separate human review before the evaluator can be marked approved. Approval is specific to the exact provider, account, model, policy, prompt, protocol, and private fixture digest; it does not enable real-case processing by itself.
