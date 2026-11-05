import { describe, expect, it } from "vitest";
import { agentTextProblem, checkAgentOutput, sharesPassage } from "../../src/domain/caseAgent/output";

const C = "11111111-1111-4111-8111-111111111111";
const R = "22222222-2222-4222-8222-222222222222";
const complainantText = "Receipt states the kettle purchase cost $89.99 on October 2.";
const respondentText = "Clearance tag says final sale; a repair voucher was offered.";
const ctx = {
  complainantEvidenceIds: new Set([C]), respondentEvidenceIds: new Set([R]),
  evidenceSources: new Map([[C, { text: complainantText }], [R, { text: respondentText }]]),
  complainantCorpus: "the kettle stopped heating after three days at home " + complainantText,
  respondentCorpus: "our counter staff offered a repair voucher for clearance items " + respondentText,
};
const ok = {
  needs_human: null, summary: "s", reasoning: "r", limits: ["l"], not_considered: ["n"],
  citations: [
    { evidence_item_id: C, relevance: "x", excerpt: "the kettle purchase cost $89.99" },
    { evidence_item_id: R, relevance: "y", excerpt: "Clearance tag says final sale" },
  ],
  outcomes: { complainant: { text: "Proposal A.", evidence_item_ids: [C] }, respondent: { text: "Proposal B.", evidence_item_ids: [R] } },
};

describe("case agent output checks", () => {
  it("accepts a well-formed, isolated reply, including inside a code fence", () => {
    expect(checkAgentOutput(JSON.stringify(ok), ctx).ok).toBe(true);
    expect(checkAgentOutput("```json\n" + JSON.stringify(ok) + "\n```", ctx).ok).toBe(true);
  });
  it("rejects extra fields, model-set reviewer fields, duplicate or foreign citations", () => {
    expect(checkAgentOutput(JSON.stringify({ ...ok, reviewer: { user_id: "x" } }), ctx).ok).toBe(false);
    expect(checkAgentOutput(JSON.stringify({ ...ok, citations: [ok.citations[0], ok.citations[0]] }), ctx).ok).toBe(false);
    expect(checkAgentOutput(JSON.stringify({ ...ok, outcomes: { ...ok.outcomes, respondent: { text: "B", evidence_item_ids: [C] } } }), ctx).ok).toBe(false);
  });
  it("rejects invented, ambiguous, or missing citation excerpts", () => {
    expect(checkAgentOutput(JSON.stringify({ ...ok, citations: [{ ...ok.citations[0], excerpt: "the seller charged $89.99" }] }), ctx).ok).toBe(false);
    const repeated = { ...ctx, evidenceSources: new Map([[C, { text: `${complainantText} ${complainantText}` }], [R, { text: respondentText }]]) };
    expect(checkAgentOutput(JSON.stringify(ok), repeated).ok).toBe(false);
    expect(checkAgentOutput(JSON.stringify({ ...ok, outcomes: { ...ok.outcomes, complainant: { text: "Proposal", evidence_item_ids: [C, R] } } }), ctx).ok).toBe(false);
  });
  it("flags verdicts, scores, legal advice, binding or pressuring language in both languages", () => {
    for (const bad of ["This is our decision.", "She is not credible.", "Il est menteur.", "There is a 70% chance.", "Vous êtes légalement tenu de payer.", "This is final and binding.", "Last chance to accept.", "La loi vous oblige à rembourser."]) {
      expect(agentTextProblem(bad), bad).not.toBeNull();
    }
    expect(agentTextProblem("Proposition non contraignante : remboursement du prix payé.")).toBeNull();
  });
  it("detects a repeated six-word passage across accents and punctuation", () => {
    expect(sharesPassage("Note: Our counter-staff offered a repair voucher!", "our counter staff offered a repair voucher for clearance")).toBe(true);
    expect(sharesPassage("A repair voucher was discussed.", ctx.respondentCorpus)).toBe(false);
  });
});
