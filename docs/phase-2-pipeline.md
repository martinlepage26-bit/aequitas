# Phase 2 — pipeline and contracts

The dispute states (`DRAFT` through `CLOSED`) and the consent flow are unchanged. Phase 2 adds an assumption ledger, model proposals, and a synthesis check beside that flow. Contestation and approver sign-off stay in Phase 3.

## Flag

The pipeline does nothing unless:

```
AEQUITAS_PIPELINE_ENABLED=true
```

Any other value, including an unset variable, leaves the case page as it was and makes every pipeline write return without inserting a row or calling a model.

Setting the flag alone does not authorize a provider call: live case data also requires the provider-terms review gate below, and Gemini additionally requires the paid-project confirmation.

## Model provider and case-data gate

This path does not use `ANTHROPIC_API_KEY` and it refuses `anthropic` and `openai` as the provider name.

| Variable | Purpose |
| --- | --- |
| `AEQUITAS_PIPELINE_ENABLED` | Must be `true` |
| `AEQUITAS_PIPELINE_PROVIDER` | `gemini` (default) or `workers-ai` |
| `GEMINI_PROJECT_ID` | Required for Gemini case data; the operator confirms that this project owns the configured API key. The app cannot verify that mapping. |
| `GEMINI_API_KEY` | API key for the chosen Gemini project |
| `GEMINI_MODEL` | Optional. Default `gemini-3.8-flash` |
| `AEQUITAS_AI_PROVIDER_TERMS_REVIEWED_FOR` | Must match `gemini:<project-id>:<model>` or `workers-ai:<account-id>:<model>`. Changing provider, account/project, or model invalidates the review. This is an operator attestation, not legal or privacy approval. |
| `AEQUITAS_GEMINI_PAID_TIER_CONFIRMED_FOR` | Must equal `GEMINI_PROJECT_ID` after confirming that exact API-key project has active billing and Paid Tier terms. A key by itself does not identify its billing tier. |
| `CLOUDFLARE_ACCOUNT_ID` | Only for `workers-ai` |
| `CLOUDFLARE_API_TOKEN` | Only for `workers-ai` |
| `AEQUITAS_WORKERS_AI_MODEL` | Optional. Default `@cf/google/gemma-4-26b-a4b-it` |

The app does not send live case data to a provider until its terms-review identity matches the selected provider, account/project, and model. Changing any of those values fails closed until the operator re-attests. Gemini's unpaid tier uses submitted content to improve Google products and may involve human review; Google's terms say not to submit sensitive, confidential, or personal information to unpaid services. The paid Gemini API terms apply only when the exact project has active billing. See [Gemini API Additional Terms](https://ai.google.dev/gemini-api/terms) and [billing tiers](https://ai.google.dev/gemini-api/docs/billing). The project ID and Paid Tier assertion remain operator-provided; the app cannot verify that the API key belongs to that project. A privacy assessment and other legal decisions remain separate.

Cloudflare documents zero retention and no training for standard Workers AI inference, with exceptions for stateful features and operational metadata. Third-party model licenses still apply. Review [Workers AI data usage](https://developers.cloudflare.com/workers-ai/platform/data-usage/) and the selected model's license before setting the terms-review flag. This does not establish that data transfers or privacy obligations are satisfied.

## Stages

1. **Assumption ledger.** A person records assumptions. They stay `PROPOSED` until that person acknowledges one. Decomposition will not run before that acknowledgement.
2. **Claim decomposition.** The model returns `{ claim_type, text, excerpt, source_id }`. The excerpt must be a verbatim substring of `Source.body`. The result is a proposal, not a claim.
3. **Context mapping.** The model returns context factors. Acceptance stores a `ContextFactor`. It does not create a claim.
4. **Synthesis.** The case page can assemble a synthesis from accepted claims without calling a model. `validateSynthesis` rejects a material sentence with no provenance link, rejects a numeric diagnostic value, and rejects any synthesis that references a disputed claim without putting that claim in the disputed section. Evidence, positionality, and context are flags (`diag_e`, `diag_p`, `diag_c`), not scores.

An assumption added after a proposal exists is stored as `MID_CASE`, logged as `ASSUMPTION_ADDED_MID_CASE`, and returns the pipeline to assumption review. The return is `PIPELINE_RETURNED`. Earlier rows are not deleted or rewritten. Revising an assumption keeps the earlier text and adds a new row.

Model text that says a party is impartial, fully compliant, or free of bias is rejected and not stored.
