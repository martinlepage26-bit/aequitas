import { z } from "zod";
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
 */

const NUMERIC_SCORE_PATTERN = /\d+\s*%|\b\d+(?:\.\d+)?\s*\/\s*(?:5|10)\b|\bstar rating\b|\bstars?\s+out of\b/i;

function scanForForbiddenContent(value: string): string | null {
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

export type AiGeneratedFields = z.infer<typeof aiGeneratedFieldsSchema>;

/** The full stored explanation record — AI-generated fields plus model/reviewer metadata our own code attaches. */
export const explanationRecordSchema = aiGeneratedFieldsSchema.extend({
  model: z.object({
    id: z.string().min(1),
    prompt_version: z.string().min(1),
  }),
  reviewer: z.object({
    user_id: z.string().uuid().nullable(),
    issued_at: z.string().datetime().nullable(),
  }),
});

export type ExplanationRecord = z.infer<typeof explanationRecordSchema>;

/** Returns null if valid, else a human-readable message for the guard's schemaValidationError. */
export function validateExplanationRecord(value: unknown): string | null {
  const result = explanationRecordSchema.safeParse(value);
  if (result.success) return null;
  return result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
}
