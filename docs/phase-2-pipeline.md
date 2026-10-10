# Phase 2 — pipeline and contracts

The dispute states (`DRAFT` through `CLOSED`) and the consent flow are unchanged. Phase 2 adds an assumption ledger, model proposals, and a synthesis check beside that flow. Contestation and approver sign-off stay in Phase 3.

## Flag

The pipeline does nothing unless:

```
AEQUITAS_PIPELINE_ENABLED=true
```

Any other value, including an unset variable, leaves the case page as it was and makes every pipeline write return without inserting a row or calling a model.

## Free model

This path does not use `ANTHROPIC_API_KEY` and it refuses `anthropic` and `openai` as the provider name.

| Variable | Purpose |
| --- | --- |
| `AEQUITAS_PIPELINE_ENABLED` | Must be `true` |
| `AEQUITAS_PIPELINE_PROVIDER` | `gemini` (default) or `workers-ai` |
| `GEMINI_API_KEY` | Google AI Studio key, free tier |
| `GEMINI_MODEL` | Optional. Default `gemini-3.8-flash` |
| `CLOUDFLARE_ACCOUNT_ID` | Only for `workers-ai` |
| `CLOUDFLARE_API_TOKEN` | Only for `workers-ai` |
| `AEQUITAS_WORKERS_AI_MODEL` | Optional. Default `@cf/meta/llama-3.1-8b-instruct-fp8` |

`gemini-3.8-flash` is the current Flash model. On 2026-10-09 the Gemini pricing page listed its free tier input and output as free of charge. The paid tier above those limits is real. Do not turn billing on.

Workers AI includes 10,000 neurons per day at no charge. Usage above that is billed, so it is not the default.

## Stages

1. **Assumption ledger.** A person records assumptions. They stay `PROPOSED` until that person acknowledges one. Decomposition will not run before that acknowledgement.
2. **Claim decomposition.** The model returns `{ claim_type, text, excerpt, source_id }`. The excerpt must be a verbatim substring of `Source.body`. The result is a proposal, not a claim.
3. **Context mapping.** The model returns context factors. Acceptance stores a `ContextFactor`. It does not create a claim.
4. **Synthesis.** The case page can assemble a synthesis from accepted claims without calling a model. `validateSynthesis` rejects a material sentence with no provenance link, rejects a numeric diagnostic value, and rejects any synthesis that references a disputed claim without putting that claim in the disputed section. Evidence, positionality, and context are flags (`diag_e`, `diag_p`, `diag_c`), not scores.

An assumption added after a proposal exists is stored as `MID_CASE`, logged as `ASSUMPTION_ADDED_MID_CASE`, and returns the pipeline to assumption review. The return is `PIPELINE_RETURNED`. Earlier rows are not deleted or rewritten. Revising an assumption keeps the earlier text and adds a new row.

Model text that says a party is impartial, fully compliant, or free of bias is rejected and not stored.
