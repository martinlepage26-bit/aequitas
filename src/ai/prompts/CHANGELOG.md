# Draft-recommendation prompt changelog

Section 9: "The prompt itself is versioned (`prompt_version`); prompts live
in `src/ai/prompts/` with a changelog. Prompt changes require the same
review as code."

## 2026-10-01.1

Adds immutable party-reported dispute chronology entries to the authoritative
source registry, with reported calendar date, title, original description,
author role, locale and submission timestamp. Chronology statements are not
verified facts or independent corroboration. Reported dates remain distinct
from application activity dates; disagreements must be preserved.

## 2026-09-22.2

Two more prompt-clarity gaps surfaced by live smoke testing 2026-09-22.1
(unrelated to that version's actual change — these are pre-existing
triangulation/relationship rules the model had just never been told
explicitly): relationships.from_id must differ from to_id (no
self-referential edges), and each triangulation source_group's source_ids
must be disjoint across groups (a source can't count toward more than one
independent pathway). Both were already enforced by
validateConflictKnowledgeMap; this only adds the missing instruction
sentences. No schema or validation change.

## 2026-09-22.1

Wires real legal-research grounding into the drafting pipeline via LegiPro
(src/lib/legipro.ts), fetched once per draft before prompt-building —
never live inside buildKnowledgeSources, which must stay a pure function
of its input since completeDraft calls it a second time to compute the
authoritative, persisted source snapshot (see the comment on
DraftPromptInput.legalResearch). Adds instruction item 8: legal_research
sources must be quoted exactly like any other source, used only to ground
context/repair-path reasoning (never a liability finding), and the model
must say plainly when none were available rather than write a statute,
section, or citation from its own training data. New knowledgeSourceSchema
kind "legal_research". Empty when LEGIPRO_API_URL/LEGIPRO_API_TOKEN are
unset — an honest gap, not a regression; existing drafting behavior is
otherwise unchanged.

## 2026-09-20.5

Adds one clarifying sentence to instruction item 6: synthesis.supported_claim_ids
must reference only claims assessed "supported", disputed_claim_ids only
claims assessed "contested". Not a new rule — `validateConflictKnowledgeMap`
already enforced it — but 2026-09-20.4's smoke test showed the model wasn't
told the exact assessment values required. No schema or validation change,
prompt-only.

## 2026-09-20.4

Adds one clarifying sentence to the Conflict Knowledge Architecture
instructions (item 5): an experience's claim_ids must reference only
claims typed "experience", not causal/factual/other claim types. This is
not a new rule — `validateConflictKnowledgeMap` (src/domain/conflictKnowledge.ts)
already enforced it — but the first live smoke test (2026-09-20.3) showed
the model wasn't told the rule and violated it. No schema or validation
change, prompt-only.

## 2026-09-20.3

Adds an explicit "Output format" section to the system prompt, spelling out
coreAiGeneratedFieldsSchema's full JSON Schema and instructing a single
fenceless JSON object in response. Needed because draftRecommendation.ts no
longer sends `output_config` — the schema's nested enums/arrays compiled
into a grammar too large for Claude's structured-output constrained
decoding (400 "The compiled grammar is too large"). The model's response is
still parsed and validated against the exact same Zod schema client-side;
only the enforcement point moved from the API to this prompt plus that
parse.

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

## 2026-09-20.1 — Aequitas Core

Makes Conflict Knowledge Architecture the draft method across all case categories.
Requires source-linked atomic claims, competing narratives, material/narrative/relational
context, reported experience, independence assessments, conditional synthesis and
consent-aware repair paths. Source text is untrusted data. Evidence descriptions are
explicitly metadata, not extracted file contents. Exact excerpts and graph references
are validated before storage; provenance snapshots are attached by the server.
