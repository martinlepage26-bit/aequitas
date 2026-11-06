import { describe, expect, it } from "vitest";
import { blankHumanReviewChecklist, sanitizeReviewText, sanitizedHumanHandoffRequest } from "../../scripts/caseAgentEvaluationReview";

describe("case-agent manual evaluation report", () => {
  it("redacts common contact identifiers echoed by a synthetic model reply", () => {
    const reportText = sanitizeReviewText("Call 514-555-0199 or email reviewer@example.org at H2X 1Y4.");
    expect(reportText).toBe("Call [REDACTED PHONE] or email [REDACTED EMAIL] at [REDACTED POSTAL CODE].");
    expect(reportText).not.toMatch(/514-555-0199|reviewer@example\.org|H2X 1Y4/);
  });

  it("truncates unusually long generated text", () => {
    const reportText = sanitizeReviewText("x".repeat(4100));
    expect(reportText).toHaveLength(4012);
    expect(reportText.endsWith("…[TRUNCATED]")).toBe(true);
  });

  it("leaves semantic-quality judgments blank for a human reviewer", () => {
    expect(blankHumanReviewChecklist()).toEqual({
      dispositionAppropriate: null,
      summaryFaithfulToCitedEvidence: null,
      reasoningNeutralAndBalanced: null,
      relevantCounterevidenceIncluded: null,
      proposalWithinProgramRules: null,
      partyPrivacyPreserved: null,
      languageClearForEachParty: null,
      reviewerNotes: "",
    });
  });

  it("includes only a bounded, sanitized human-handoff reason from a synthetic model reply", () => {
    expect(sanitizedHumanHandoffRequest('{"needs_human":"Contact 514-555-0199 for legal review."}'))
      .toBe("Contact [REDACTED PHONE] for legal review.");
    expect(sanitizedHumanHandoffRequest("not JSON")).toBeNull();
    expect(sanitizedHumanHandoffRequest(JSON.stringify({ needs_human: "x".repeat(501) }))).toBeNull();
  });
});
