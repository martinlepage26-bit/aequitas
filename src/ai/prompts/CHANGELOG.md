# Draft-recommendation prompt changelog

Section 9: "The prompt itself is versioned (`prompt_version`); prompts live
in `src/ai/prompts/` with a changelog. Prompt changes require the same
review as code."

## 2026-08-15.2

Multi-domain pivot (`.claude/handoffs/2026-08-15-070312-aequitas-modular-db-reset.md`):
`Case.category` (`DisputeCategory`) replaces the retail-only assumption.
System prompt now names the actual dispute domain ("residential tenancy
dispute", "employment dispute", etc. — see `src/ai/prompts/router.ts`'s
`DOMAIN_LABELS`) instead of always saying "consumer dispute", and tells the
model the domain-appropriate term for each party (e.g. "tenant"/"landlord")
instead of assuming "consumer"/"retailer". User prompt's evidence/position
section headings use those same domain terms. Hard constraints, output
schema, and the Section 12 terminology glossary are unchanged — this is
framing only, routed by category, not a change to what's enforced.

## 2026-08-15.1

Initial version. System prompt states the hard constraints (no "decision"
language, no numeric scores/percentages/star ratings, citations must
resolve to provided evidence IDs, non-empty `limits`/`not_considered`,
write in the case locale) and the Section 12 terminology glossary. User
prompt sends evidence metadata (kind/title/description — no extracted file
text; no OCR/PDF-parsing pipeline exists in this build) and both parties'
position statements.
