# Aequitas Core backend

`Aequitas Core.txt` is the product-method source for the active backend. Its
research references are incomplete labels, not a verified citation library. The
implementation uses its inquiry method; it does not treat the document as case
evidence or independently validated clinical or legal authority.

## Implemented contract

Every new AI draft includes a versioned Conflict Knowledge Map:

- Atomic factual, causal, moral, identity, policy and experience claims.
- Exact source excerpts, with original language preserved.
- Competing narratives with standpoint and assumptions.
- Material, narrative and relational context, distinguishing documented factors
  from hypotheses and unknowns; questions about power and alternative explanations.
- Reported experiences, recognition needs and voluntary disclosure safeguards.
- Typed graph relationships with explicit uncertainty.
- Source independence groups and separate data, investigator, theory and method
  assessments, including missing evidence.
- Conditional synthesis with supported/contested claim references and revision
  conditions; repair options with prerequisites, accountability and consent.

The method is `aequitas-core-v1`; the drafting prompt is `2026-09-22.1` (see
`src/ai/prompts/CHANGELOG.md` for the full version history).
It applies across all existing dispute categories. Human review and party consent
remain separate from AI assessments.

## Legal research (LegiPro)

`src/lib/legipro.ts` queries an external legal-search API once per draft,
before prompt-building — `POST /v0/search/routed` against
`LEGIPRO_API_URL`, scoped by `LEGIPRO_API_TOKEN`. The query is built from
the case's category (`src/ai/prompts/router.ts`'s domain label) plus the
app's established Québec, Canada jurisdiction scope; it is never a
per-case-specific statute guessed by this code or by the model.

Results become `knowledge_source` entries of `kind: "legal_research"`, cited
under the exact same excerpt-matching rule as every other source (see
`validateConflictKnowledgeMap`) — the model can quote what LegiPro actually
returned, never a remembered statute name or section number. When
`LEGIPRO_API_URL`/`LEGIPRO_API_TOKEN` are unset, or the search fails or times
out, this is an empty list, not a fabricated one; the drafting prompt
explicitly instructs the model to say plainly that no legal research was
available rather than invent a citation. This is the same honest-degradation
pattern already used for `ANTHROPIC_API_KEY` and the database connection —
see DECISIONS.md.

**This is legal research support for a human reviewer, not adjudication.**
Nothing in this pipeline determines liability, issues a binding ruling, or
constitutes legal advice — the hard constraint against the word "decision"
and the mandatory human-review-before-issuance gate (Section 9) are
unchanged and apply to legal_research-informed drafts exactly as to any
other draft.

## Persistence, provenance and validation

The map lives at `Recommendation.explanation.conflict_knowledge` in PostgreSQL.
The server attaches `knowledge_sources` from clean case evidence metadata and
both current position statements, including record IDs, versions, submitted roles,
creation dates, original position locales and evidence file hashes. The model
cannot author source registry entries, model metadata or reviewer identity.

This is a graph stored as a versioned JSON document; it does not require a second
database or a schema migration. Existing draft, issue and export workflows carry
it with the recommendation. The JSON export contains the complete graph and source
snapshot; the sealed PDF includes the full map and source snapshots.

New generation requires the map. Historical records without one remain readable.
Validation rejects missing sources, fabricated or translated-as-original excerpts,
dangling node references, duplicate node IDs, duplicated source counting, identical
files separated into different source groups, unsupported documented contexts,
experience references to non-experience claims, and synthesis labels that disagree
with the underlying claim assessments. Top-level evidence citations must resolve
to clean evidence in this case. Issuance rechecks graph integrity and clean evidence.

Exact-excerpt matching establishes traceability, not factual truth, source
independence, relevance, legal liability or diagnostic validity. Assessment labels
are qualitative proposals for review, not probabilities or credibility scores.

## API and review

- `POST /api/cases/:caseId/draft-requests`: existing authenticated, assigned-manager
  generation workflow; requires the existing intake and position preconditions.
- `POST /api/cases/:caseId/recommendation`: compatibility alias to that same
  workflow. The former body-supplied manager role and SQLite generation path no
  longer authorize AI calls. The old demo payload/response contract is retired.
- `GET /api/cases/:caseId/draft`: assigned manager receives the explanation,
  graph and source snapshot.
- `GET /api/cases/:caseId/knowledge-map`: returns the current map, sources,
  recommendation version, status, model and reviewer. Only the assigned manager
  can read a draft; case parties can read an issued map. Unrelated users, other
  managers and admins without case participation receive 404. Responses are private
  and non-cacheable. Legacy recommendations without maps return 404.
- `PATCH /api/cases/:caseId/draft`: assigned manager submits
  `{ "recommendationId": "current-id", "explanation": { ... }, "reason": "..." }`.
  Explanation must include `summary`, `proposed_outcome`, `reasoning`,
  `evidence_citations`, `limits`, `not_considered`, and `conflict_knowledge`.
  Source registry and model/reviewer fields are server-controlled. The backend
  validates the full replacement against the original source snapshot and creates
  a new draft version, superseding the old version without overwriting its content.
  Draft and private review-note events record the actor, versions and reason.
  The new version still needs the existing human issuance checklist.

Generation, correction and issuance compare the current recommendation under a
transactional case-row lock. Stale operations return a conflict rather than silently
replacing or issuing another version. Existing broader lifecycle concurrency rules
remain outside this change.

The bilingual workspace renders the map next to the recommendation before the
issuance controls. The bilingual review form edits claims, interpretations, context,
relationships, uncertainty and repair paths, with a required review reason. The
graph explorer navigates connected nodes and original source snapshots. Corrections
create a new version; they do not overwrite the original AI draft.

## Operational limits

- An Anthropic API key and configured model are needed for live generation.
  Tests use synthetic records and do not establish live model quality.
- Clean attachments are downloaded and checked against their recorded byte size
  and SHA-256 before extraction. UTF-8 text, PDF text (`pdftotext`) and image OCR
  (`tesseract`) are supported. Missing native tools yield an explicit metadata-only
  source; integrity failures block drafting. Scanned PDFs are not OCRed.
- Extraction is limited to 25 MiB per file, 20 PDF pages, 12,000 characters per
  source, 12 files and 60,000 characters per case. Native processes have a 15-second
  timeout and 512 KiB output cap. Extracted quotations require original-file review.
- Configure `AEQUITAS_PDFTOTEXT_PATH`, `AEQUITAS_TESSERACT_PATH` and
  `AEQUITAS_OCR_LANGUAGES` as needed. OCR defaults to `eng`; bilingual installations
  should install French language data and select `eng+fra`. There is no external
  web research or general image interpretation.
- Independence beyond exact duplicate file hashes, contextual relevance and
  ethical interpretation require human assessment.
- The existing two-party case model remains in use; the ontology supports multiple
  interpretations but does not introduce multi-party membership management.
- No new retention/deletion service, translation-review workflow or standalone
  graph database is introduced. Existing consent and export mechanisms remain.
- The legacy demo homepage and its unrelated message endpoint remain demonstration
  infrastructure. New core work is in authenticated locale-specific case workspaces.

## Verification

Run `npx vitest run test/unit`, `npm run lint`, `npm run typecheck`,
`npm run check:i18n-parity`, `npm run check:forbidden-terms`, and `npm run build`.
New tests cover graph/provenance rejection, bilingual source preservation,
structured-output schema conversion, access isolation, draft persistence,
version-preserving human review and stale review/issue conflicts. Database and
browser integration tests additionally require the configured local services.


For this host's user-local browser installation, run
`PLAYWRIGHT_BROWSERS_PATH=/home/martin/.cache/ms-playwright npm run test:e2e`.
Run browser tests and the HTTP integration suite sequentially: both start a Next.js
development server, and this checkout permits only one development-server lock.

### Local verification — 2026-09-20

- Full existing Vitest suite: 526 passed. Added rendered-PDF check: 1 passed;
  post-issuance event replay checks: 4 passed.
- English and French intake browser workflows passed. English and French core
  review workflows passed after correcting the source-excerpt selector and
  separating review/issuance React keys; the save response is asserted as HTTP 200.
- Production build, TypeScript, lint, translation parity and terminology checks
  passed. Storage bucket availability was verified.
- The event audit checked 1,310 local cases. Fixing the missing post-issuance
  replay transitions removed all 42 projection mismatches. Six intentionally
  corrupted `AE-TAMPER-BAD-*` fixtures remain detectable; the global audit exits 1.
  No historical records were deleted or repaired to hide these findings.
- `npm run smoke:core-ai` exited 2 because Anthropic configuration is missing.
  No live AI request was sent, and live model quality remains unverified.
- These are local checkout results, not deployment verification.
