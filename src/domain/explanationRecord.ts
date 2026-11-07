import { z } from "zod";
import { conflictKnowledgeMapSchema, knowledgeSourceSchema } from "./conflictKnowledge";
import { FORBIDDEN_TERMS } from "../i18n/glossary";

/**
 * Section 9's explanation-record schema, validated on write. Two layers:
 * 1. Structural (this file, Zod) — required fields, non-empty arrays,
 *    citation IDs are UUIDs, a best-effort scan of free-text fields for
 *    numeric-scoring language.
 * 2. Semantic (src/domain/mutate.ts's completeDraft, via guards.ts) —
 *    every cited evidence_item_id actually resolves to a CLEAN item in
 *    THIS case. That check needs a database read, which a Zod schema
 *    can't perform — it's deliberately kept out of this file.
 *
 * "No numeric scores, percentages of fault, or star ratings anywhere in
 * the output" (Section 9) is inherently a heuristic to check mechanically:
 * a dollar amount traced to evidence is explicitly ALLOWED, so this can't
 * reject all digits. It rejects the unambiguous patterns — percentages and
 * star/out-of-N ratings — plus the same FORBIDDEN_TERMS the i18n glossary
 * already polices in UI copy (Section 12), extended here to the AI's own
 * generated content. It does not and cannot guarantee "properly traced to
 * evidence" for a dollar figure — that remains a human review judgment,
 * per Section 9's own UI requirement (case manager reviews before issuing).
 * Case-agent records additionally link each summary, reasoning, and proposal
 * rationale claim to a verified extracted span. The link makes review
 * traceable; it cannot prove that the quoted wording semantically supports
 * the claim.
 */

const NUMERIC_SCORE_PATTERN = /\d+\s*%|\b\d+(?:\.\d+)?\s*\/\s*(?:5|10)\b|\bstar rating\b|\bstars?\s+out of\b/i;

const extractedSpanSchema = z.object({
  start_char: z.number().int().nonnegative(),
  end_char: z.number().int().positive(),
  source_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  extracted_text_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  extraction_method: z.enum(["utf8", "pdftotext", "tesseract"]),
  // 1-based PDF page, counted from pdftotext's form-feed page breaks.
  page: z.number().int().positive().optional(),
}).strict();

const evidenceCitationSchema = z.object({
  // The autonomous case agent uses a stable per-response key to link each
  // generated claim to this exact, hash-verified span. Older records omit it.
  citation_id: z.string().regex(/^C[1-9]\d{0,2}$/).optional(),
  evidence_item_id: z.string().uuid("evidence_item_id must be a UUID"),
  relevance: z.string().min(1, "relevance is required"),
  // The autonomous agent adds a server-computed pointer into a hash-verified
  // extraction. Older AI and human-authored records remain valid without it.
  extracted_span: extractedSpanSchema.optional(),
});

const claimEvidenceSchema = z.object({
  section: z.enum(["summary", "reasoning", "proposal"]),
  text: z.string().min(1).max(500),
  citation_ids: z.array(z.string().regex(/^C[1-9]\d{0,2}$/)).min(1).max(10),
}).strict();

export function scanForForbiddenContent(value: string): string | null {
  if (NUMERIC_SCORE_PATTERN.test(value)) {
    return "contains a percentage or star-rating pattern, which Section 9 forbids";
  }
  for (const pattern of FORBIDDEN_TERMS) {
    if (pattern.test(value)) {
      return `contains a forbidden term (matches ${pattern})`;
    }
  }
  return null;
}

function noForbiddenContent(value: string, ctx: z.RefinementCtx) {
  const reason = scanForForbiddenContent(value);
  if (reason) ctx.addIssue({ code: "custom", message: reason });
}

function wordCount(value: string): number {
  return value.trim().length === 0 ? 0 : value.trim().split(/\s+/).length;
}

/**
 * What Claude itself generates. Deliberately excludes `model` and
 * `reviewer` — those are populated by our own code (the model/prompt that
 * actually served the request; the reviewer only once a human issues it),
 * never by the model's own output. Asking Claude to fill in its own model
 * ID or a null reviewer object would just be inviting it to hallucinate
 * fields it has no way to know.
 */
export const aiGeneratedFieldsSchema = z.object({
  summary: z
    .string()
    .min(1, "summary is required")
    .superRefine((value, ctx) => {
      if (wordCount(value) > 120) ctx.addIssue({ code: "custom", message: "summary must be <= 120 words" });
      noForbiddenContent(value, ctx);
    }),
  proposed_outcome: z.string().min(1, "proposed_outcome is required").superRefine(noForbiddenContent),
  reasoning: z.string().min(1, "reasoning is required").superRefine(noForbiddenContent),
  // Optional so historical and human-authored records remain readable. The
  // autonomous case agent writes it only with a linked claim-evidence map.
  proposal_reasoning: z.string().max(4008).optional().superRefine((value, ctx) => {
    if (value !== undefined) noForbiddenContent(value, ctx);
  }),
  evidence_citations: z.array(
    z.object({
      evidence_item_id: z.string().uuid("evidence_item_id must be a UUID"),
      relevance: z.string().min(1, "relevance is required"),
    })
  ),
  // Section 9: "empty arrays fail validation. A recommendation that claims
  // no limits is definitionally overclaiming."
  limits: z.array(z.string().min(1)).min(1, "limits must be non-empty"),
  not_considered: z.array(z.string().min(1)).min(1, "not_considered must be non-empty"),
});

// Historical explanation records remain readable; every new AI response requires the map.
export const coreAiGeneratedFieldsSchema = aiGeneratedFieldsSchema.extend({
  conflict_knowledge: conflictKnowledgeMapSchema,
});

export type AiGeneratedFields = z.infer<typeof aiGeneratedFieldsSchema>;

/** The full stored explanation record — AI-generated fields plus model/reviewer metadata our own code attaches. */
export const explanationRecordSchema = aiGeneratedFieldsSchema.extend({
  evidence_citations: z.array(evidenceCitationSchema),
  // Optional so historical AI and human-authored records remain readable.
  claim_evidence: z.array(claimEvidenceSchema).optional(),
  conflict_knowledge: conflictKnowledgeMapSchema.optional(),
  knowledge_sources: z.array(knowledgeSourceSchema).optional(),
  model: z.object({
    id: z.string().min(1),
    prompt_version: z.string().min(1),
  }),
  reviewer: z.object({
    user_id: z.string().uuid().nullable(),
    issued_at: z.string().datetime().nullable(),
  }),
}).superRefine((record, ctx) => {
  const citationIds = record.evidence_citations.flatMap((citation) => citation.citation_id ? [citation.citation_id] : []);
  if (new Set(citationIds).size !== citationIds.length) {
    ctx.addIssue({ code: "custom", path: ["evidence_citations"], message: "citation_id values must be unique" });
  }
  for (const [index, citation] of record.evidence_citations.entries()) {
    if (citation.citation_id && !citation.extracted_span) {
      ctx.addIssue({ code: "custom", path: ["evidence_citations", index, "extracted_span"], message: "agent citation IDs require a verified extracted span" });
    }
  }
  const linkedClaims = record.claim_evidence ?? [];
  if (citationIds.length > 0 && linkedClaims.length === 0) {
    ctx.addIssue({ code: "custom", path: ["claim_evidence"], message: "agent citation IDs require claim-to-evidence links" });
  }
  if (linkedClaims.length === 0) return;
  const citationIdSet = new Set(citationIds);
  const usedCitationIds = new Set<string>();
  for (const [index, claim] of linkedClaims.entries()) {
    const sectionText = claim.section === "proposal" ? record.proposal_reasoning ?? "" : record[claim.section];
    if (!sectionText.includes(claim.text)) {
      ctx.addIssue({ code: "custom", path: ["claim_evidence", index, "text"], message: `claim text must appear in its ${claim.section} section` });
    }
    if (new Set(claim.citation_ids).size !== claim.citation_ids.length) {
      ctx.addIssue({ code: "custom", path: ["claim_evidence", index, "citation_ids"], message: "claim citation IDs must be unique" });
    }
    for (const citationId of claim.citation_ids) {
      if (!citationIdSet.has(citationId)) {
        ctx.addIssue({ code: "custom", path: ["claim_evidence", index, "citation_ids"], message: `unknown citation_id ${citationId}` });
      }
      usedCitationIds.add(citationId);
    }
  }
  for (const citationId of citationIds) {
    if (!usedCitationIds.has(citationId)) {
      ctx.addIssue({ code: "custom", path: ["evidence_citations"], message: `citation_id ${citationId} is not linked to a claim` });
    }
  }
});

export type ExplanationRecord = z.infer<typeof explanationRecordSchema>;

/** Returns null if valid, else a human-readable message for the guard's schemaValidationError. */
export function validateExplanationRecord(value: unknown): string | null {
  const result = explanationRecordSchema.safeParse(value);
  if (result.success) return null;
  return result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
}
