# Workers AI synthetic evaluation: owner review brief

**Status:** prepared for review. On 2026-11-10, Martin selected the account below and confirmed a US$0.11 synthetic-only evaluation ceiling. No account-specific provider-terms or human-reference approval is recorded. This brief does not authorize production case processing.

## Exact evaluation target

- Provider: Cloudflare Workers AI.
- Account: `1713c51cc6fbcf8d7143526b93495b76`.
- Model: `@cf/google/gemma-4-26b-a4b-it`.
- Scope: seven synthetic fixtures, using the benchmark policy and evaluation identity in [the baseline worksheet](case-agent-baseline-review-worksheet.md).
- Authorized synthetic evaluation ceiling: **US$0.11**.
- The evaluator's local worst-case request-bound estimate is about **US$0.10241281**. It refuses a run when its estimate exceeds the supplied ceiling and reserves the bound before each request. This is a local guard, not a Cloudflare account spending limit. It cannot account for other or concurrent account use; Cloudflare billing is authoritative.

## Current provider documentation

Reviewed on 2026-11-10:

- Cloudflare's [model page](https://developers.cloudflare.com/workers-ai/models/gemma-4-26b-a4b-it/) lists the selected model as hosted by Cloudflare, identifies zero data retention, and lists rates of US$0.10 per million input tokens and US$0.30 per million output tokens. The [Workers AI pricing page](https://developers.cloudflare.com/workers-ai/platform/pricing/) shows the same token rates.
- Cloudflare's [Workers AI data-usage page](https://developers.cloudflare.com/workers-ai/platform/data-usage/) says it does not use Workers AI customer content to train AI models. For ordinary inference without a stateful feature, it says inputs and outputs are not retained after they are no longer needed to process the request and deliver the response. It describes exceptions for legal obligations or commitments, and notes that storage, asynchronous features, AI Gateway logging or caching, and application logs can retain content according to those features' settings and lifecycles. It also distinguishes operational metadata, which may be retained and does not include customer content.
- The model page links to Google's [Gemma 4 Apache 2.0 license](https://ai.google.dev/gemma/apache_2).

These published statements do not establish the selected account's plan, billing state, remaining daily allowance, account-level settings, configured gateway or application logging, processing location, or legal suitability for any program. The documentation is not a Québec privacy assessment or legal opinion. Confirm the applicable Cloudflare agreement and actual configuration before authorizing even this synthetic request. No real case data may be used in this evaluation.

## Local credential setup

The evaluation runner pins the selected account and model; the only provider credential it needs from the local environment is `CLOUDFLARE_API_TOKEN`. Cloudflare's [Workers AI REST setup guide](https://developers.cloudflare.com/workers-ai/get-started/rest-api/) provides a Workers AI token template. If creating a custom token instead, Cloudflare says to grant both `Workers AI - Read` and `Workers AI - Edit`.

For this repository, standalone scripts load the repository-root `.env.local` first, then `.env`; `.env*` files are ignored by Git. Set `CLOUDFLARE_API_TOKEN` in `.env.local` on the operator's machine only. Never put the value in chat, the tracked example file, a review worksheet, a commit, or the PR. No token was configured in the loaded environment when this brief was refreshed on 2026-11-10. Do not make a provider request until the human references, account terms/settings review, and one-run approval are complete.

## Human review still required before the first request

1. A qualified program case reviewer independently assesses all seven fixtures using only the [blind reviewer packet](case-agent-blind-reference-packet.md).
2. Counsel independently reviews the two legal-handoff fixtures.
3. A qualified Québec French reviewer independently assesses all five fixtures with an fr-CA party.
4. Record and resolve disagreements in a private copy of the worksheet, then freeze the references before any model output. Do not show reviewers the named worksheet or reference protocol before their independent assessments.
5. The owner records that the selected provider terms and US$0.11 synthetic-only ceiling are acceptable. This is not buyer-program or production approval.

The evaluator remains fail-closed until the exact baseline-review identity is attested and the owner has set its separate live-evaluation approval. The Cloudflare token must be configured locally as a scoped secret; never add it to this repository, the worksheet, or chat. The local presence check on 2026-11-10 found no token and no approval attestation, so no provider request has been made.
