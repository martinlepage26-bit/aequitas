import type { DisputeCategory } from "../../generated/prisma";
import { GLOSSARY } from "../../i18n/glossary";
import { routePromptContext } from "./router";

/**
 * Prompt is versioned (Section 9: "The prompt itself is versioned
 * (prompt_version); prompts live in src/ai/prompts/ with a changelog.
 * Prompt changes require the same review as code."). Bump this and add an
 * entry to CHANGELOG.md whenever buildDraftPrompt's output changes in any
 * way that could affect model behavior.
 */
export const PROMPT_VERSION = "2026-08-15.2";

export interface EvidenceSummary {
  id: string;
  kind: string;
  title: string;
  description: string | null;
  submittedByRole: "complainant" | "respondent";
}

export interface PositionSummary {
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
}

/**
 * Section 9's pipeline: "system assembles a prompt containing the case's
 * evidence metadata + extracted text, both positions, and the glossary
 * constraints." This build has no text-extraction pipeline for uploaded
 * files (OCR/PDF-parsing is out of scope — see DECISIONS.md) — the prompt
 * sends evidence METADATA only (kind, title, description), not file
 * content. Logged as a scope limitation, not silently implied to be more
 * than it is.
 *
 * PROMPT_VERSION 2026-08-15.2 (see CHANGELOG.md): category-routed via
 * routePromptContext (src/ai/prompts/router.ts) — the domain label and
 * party terms are no longer hardcoded to "consumer dispute" /
 * "consumer" / "retailer handler".
 */
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

Ground every claim in the evidence and positions provided. Do not speculate about facts not present in the case file.`;
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

Draft a proposed outcome for this case now, following the schema and hard constraints from the system prompt.`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
