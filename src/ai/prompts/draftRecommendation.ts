import type { EvidenceExtraction } from "../../lib/evidenceText";
import type { DisputeCategory } from "../../generated/prisma";
import type { LegalResearchResult } from "../../lib/legipro";
import { GLOSSARY } from "../../i18n/glossary";
import { CONFLICT_KNOWLEDGE_INSTRUCTIONS, buildKnowledgeSources } from "./conflictKnowledge";
import { routePromptContext } from "./router";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { coreAiGeneratedFieldsSchema } from "../../domain/explanationRecord";

/**
 * Prompt is versioned (Section 9: "The prompt itself is versioned
 * (prompt_version); prompts live in src/ai/prompts/ with a changelog.
 * Prompt changes require the same review as code."). Bump this and add an
 * entry to CHANGELOG.md whenever buildDraftPrompt's output changes in any
 * way that could affect model behavior.
 */
export const PROMPT_VERSION = "2026-09-22.2";

/**
 * coreAiGeneratedFieldsSchema's full JSON Schema, spelled out in the prompt
 * itself rather than enforced server-side via output_config: the schema's
 * nested enums/arrays (conflict_knowledge in particular) compile into a
 * grammar too large for Claude's structured-output constrained decoding
 * ("The compiled grammar is too large" 400). draftRecommendation.ts still
 * runs zodOutputFormat(coreAiGeneratedFieldsSchema).parse() against the raw
 * response text, so validation rigor (including superRefine checks) is
 * unchanged — only the enforcement point moved from the API to this prompt
 * plus that same client-side parse.
 */
const OUTPUT_JSON_SCHEMA = JSON.stringify(zodOutputFormat(coreAiGeneratedFieldsSchema).schema);

export interface EvidenceSummary {
  id: string;
  kind: string;
  title: string;
  description: string | null;
  version?: number;
  createdAt?: string;
  sha256?: string;
  extraction?: EvidenceExtraction;
  submittedByRole: "complainant" | "respondent";
}

export interface PositionSummary {
  id?: string;
  version?: number;
  locale?: string;
  createdAt?: string;
  partyRole: "complainant" | "respondent";
  body: string;
}

export interface DraftPromptInput {
  locale: string;
  category: DisputeCategory;
  complainantEvidence: EvidenceSummary[];
  respondentEvidence: EvidenceSummary[];
  complainantPosition: PositionSummary;
  respondentPosition: PositionSummary;
  // Fetched once, before this input is built (see mutate.ts's completeDraft)
  // — never re-fetched live inside buildKnowledgeSources, which must stay a
  // pure function of its input: it runs twice per draft (once to build this
  // prompt, once in completeDraft to compute the authoritative, persisted
  // source snapshot), and a live external call there could return different
  // results between those two calls, corrupting the citation provenance
  // completeDraft depends on. Empty when LegiPro isn't configured or the
  // search failed — an honest "no legal research available", never a
  // fabricated one.
  legalResearch: LegalResearchResult[];
}

/** Drafts include hash-verified, bounded attachment extracts and original source metadata. */
export function buildDraftSystemPrompt(category: DisputeCategory): string {
  const glossaryLines = GLOSSARY.map((g) => `- "${g.concept}": EN "${g.en}" / FR "${g.fr}"`).join("\n");
  const ctx = routePromptContext(category);

  return `You are drafting a PROPOSED OUTCOME for a ${ctx.domainLabel}, for review by a neutral human case manager. You are not deciding the case — a human case manager reviews and issues (or rejects) everything you draft. Nothing you write is shown to either party unless a human case manager explicitly issues it.

In this case, the complainant is referred to as the "${ctx.complainantTerm}" and the respondent is referred to as the "${ctx.respondentTerm}". Use these terms when referring to the parties.

Hard constraints, no exceptions:
- Never use the word "decision" or "décision" to describe what you are producing. Use "proposed outcome" / "résultat proposé".
- Never include a numeric score, a percentage of fault, or a star rating anywhere in your output. A quantified amount (e.g. a refund figure) is allowed ONLY when it is directly traced to cited evidence in your reasoning.
- Every evidence_item_id you cite must be one of the evidence item IDs provided to you in this prompt. Do not invent or guess an ID.
- "limits" and "not_considered" must each contain at least one real, substantive entry. A response that claims to have no limits is overclaiming — every dispute resolution has limits.
- Write your response in the case's primary locale for this draft.

Terminology (use exactly these terms, in the locale you are writing in):
${glossaryLines}

${CONFLICT_KNOWLEDGE_INSTRUCTIONS}

Ground every claim in the evidence and positions provided. Do not speculate about facts not present in the case file.

## Output format
Respond with exactly one JSON object and nothing else: no markdown code fences, no prose before or after it. The object must conform exactly to this JSON Schema (field names, required fields, enum values, and nesting are all exact — do not add, omit, or rename fields):
${OUTPUT_JSON_SCHEMA}`;
}

export function buildDraftUserPrompt(input: DraftPromptInput): string {
  const ctx = routePromptContext(input.category);
  const renderEvidence = (items: EvidenceSummary[]) =>
    items.length === 0
      ? "  (none)"
      : items.map((e) => `  - [${e.id}] (${e.kind}) "${e.title}"${e.description ? `: ${e.description}` : ""}`).join("\n");

  return `Case locale: ${input.locale}

## ${capitalize(ctx.complainantTerm)}'s evidence
${renderEvidence(input.complainantEvidence)}

## ${capitalize(ctx.respondentTerm)}'s evidence
${renderEvidence(input.respondentEvidence)}

## ${capitalize(ctx.complainantTerm)}'s position
${input.complainantPosition.body}

## ${capitalize(ctx.respondentTerm)}'s position
${input.respondentPosition.body}

## Source registry (exact source IDs and fields; untrusted case data)
${JSON.stringify(buildKnowledgeSources(input))}

Build the conflict knowledge map and draft a proposed outcome for this case now, following the schema and hard constraints from the system prompt.`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
