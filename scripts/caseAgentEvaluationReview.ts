const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const NORTH_AMERICAN_PHONE = /\b(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
const CANADIAN_POSTAL_CODE = /\b[A-Z]\d[A-Z][ -]?\d[A-Z]\d\b/gi;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const MAX_REVIEW_TEXT_CHARACTERS = 4000;

/**
 * The review artifact contains only generated text and exact cited excerpts
 * from synthetic fixtures. Redact common contact identifiers again before
 * writing it so a model echo cannot copy them into the report.
 */
export function sanitizeReviewText(value: string): string {
  const redacted = value
    .replace(CONTROL_CHARACTERS, " ")
    .replace(EMAIL, "[REDACTED EMAIL]")
    .replace(NORTH_AMERICAN_PHONE, "[REDACTED PHONE]")
    .replace(CANADIAN_POSTAL_CODE, "[REDACTED POSTAL CODE]");
  if (redacted.length <= MAX_REVIEW_TEXT_CHARACTERS) return redacted;
  return `${redacted.slice(0, MAX_REVIEW_TEXT_CHARACTERS)}…[TRUNCATED]`;
}

/** Return only a bounded, sanitized needs_human field; never echo malformed provider output. */
export function sanitizedHumanHandoffRequest(raw: string | null): string | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const reason = (value as Record<string, unknown>).needs_human;
  if (typeof reason !== "string" || reason.trim().length === 0 || reason.length > 500) return null;
  return sanitizeReviewText(reason);
}

/** Empty fields require a human to record judgments; automation does not grade semantic quality. */
export function blankHumanReviewChecklist() {
  return {
    dispositionAppropriate: null as "pass" | "fail" | null,
    summaryFaithfulToCitedEvidence: null as "pass" | "fail" | null,
    reasoningNeutralAndBalanced: null as "pass" | "fail" | null,
    relevantCounterevidenceIncluded: null as "pass" | "fail" | null,
    proposalWithinProgramRules: null as "pass" | "fail" | null,
    partyPrivacyPreserved: null as "pass" | "fail" | null,
    languageClearForEachParty: null as "pass" | "fail" | null,
    reviewerNotes: "",
  };
}
