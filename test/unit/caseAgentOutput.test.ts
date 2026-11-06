import { describe, expect, it } from "vitest";
import { agentTextProblem, checkAgentOutput } from "../../src/domain/caseAgent/output";
import { proposalProblem, renderProposal } from "../../src/domain/caseAgent/proposal";
import { caseAgentProgram } from "../../src/domain/caseAgent/config";

const C = "11111111-1111-4111-8111-111111111111";
const R = "22222222-2222-4222-8222-222222222222";
const complainantText = "Receipt states the kettle purchase cost $89.99 on October 2.";
const respondentText = "Clearance tag says final sale; a repair voucher was offered.";
const ctx = {
  complainantEvidenceIds: new Set([C]), respondentEvidenceIds: new Set([R]),
  evidenceSources: new Map([[C, { text: complainantText }], [R, { text: respondentText }]]),
  amountAtStakeCents: 8999,
};
const ok = {
  needs_human: null,
  summary_claims: [{ text: "The receipt records the purchase price.", citation_ids: ["C1"] }],
  reasoning_claims: [{ text: "The submitted records document the purchase and the sale condition.", citation_ids: ["C1", "C2"] }],
  limits: ["l"], not_considered: ["n"],
  citations: [
    { citation_id: "C1", evidence_item_id: C, relevance: "x", excerpt: "the kettle purchase cost $89.99" },
    { citation_id: "C2", evidence_item_id: R, relevance: "y", excerpt: "Clearance tag says final sale" },
  ],
  proposal: {
    remedy: "repair", amount_cents: null,
    rationale_claims: [{ text: "The store note records an offered repair voucher.", citation_ids: ["C2"] }],
  },
  party_evidence: { complainant: [C], respondent: [R] },
};
const check = (value: unknown, context = ctx) => checkAgentOutput(typeof value === "string" ? value : JSON.stringify(value), context);

describe("case agent output checks", () => {
  it("accepts a well-formed, isolated reply, including inside a code fence", () => {
    expect(check(ok).ok).toBe(true);
    expect(check("```json\n" + JSON.stringify(ok) + "\n```").ok).toBe(true);
  });
  it("rejects extra fields, free-text outcomes, model-set reviewer fields, duplicate or foreign citations", () => {
    expect(check({ ...ok, reviewer: { user_id: "x" } }).ok).toBe(false);
    expect(check({ ...ok, outcomes: { complainant: { text: "free text", evidence_item_ids: [C] } } }).ok).toBe(false);
    expect(check({ ...ok, citations: [ok.citations[0], ok.citations[0]] }).ok).toBe(false);
    expect(check({ ...ok, party_evidence: { complainant: [C], respondent: [C] } }).ok).toBe(false);
    expect(check({ ...ok, party_evidence: { complainant: [C, R], respondent: [R] } }).ok).toBe(false);
  });
  it("requires every summary, reasoning, and proposal rationale claim to reference a verified citation key", () => {
    expect(check({ ...ok, summary_claims: [{ text: "Unlinked claim.", citation_ids: [] }] }).ok).toBe(false);
    expect(check({ ...ok, summary_claims: [{ text: "Unknown source.", citation_ids: ["C9"] }] }).ok).toBe(false);
    expect(check({
      ...ok,
      reasoning_claims: [{ text: "No claim points to C2.", citation_ids: ["C1"] }],
      proposal: { ...ok.proposal, rationale_claims: [{ text: "The receipt records the purchase price.", citation_ids: ["C1"] }] },
    }).ok).toBe(false);
    expect(check({ ...ok, proposal: { ...ok.proposal, rationale_claims: [{ text: "Unknown source.", citation_ids: ["C9"] }] } }).ok).toBe(false);
    expect(check({ ...ok, proposal: { ...ok.proposal, rationale_claims: [] } }).ok).toBe(false);
  });
  it("rejects invented, ambiguous, or missing citation excerpts", () => {
    expect(check({ ...ok, citations: [{ ...ok.citations[0], excerpt: "the seller charged $89.99" }, ok.citations[1]] }).ok).toBe(false);
    const repeated = { ...ctx, evidenceSources: new Map([[C, { text: `${complainantText} ${complainantText}` }], [R, { text: respondentText }]]) };
    expect(check(ok, repeated).ok).toBe(false);
    expect(check({ ...ok, citations: [ok.citations[0]] }).ok).toBe(false);
  });
  it("rejects proposals outside the case: missing, stray, or excessive amounts", () => {
    expect(check({ ...ok, proposal: { ...ok.proposal, remedy: "refund_partial", amount_cents: null } }).ok).toBe(false);
    expect(check({ ...ok, proposal: { ...ok.proposal, remedy: "repair", amount_cents: 100 } }).ok).toBe(false);
    expect(check({ ...ok, proposal: { ...ok.proposal, remedy: "store_credit", amount_cents: 9000 } }).ok).toBe(false);
    expect(check({ ...ok, proposal: { ...ok.proposal, remedy: "pay_damages", amount_cents: 100 } }).ok).toBe(false);
    expect(proposalProblem({ remedy: "refund_partial", amount_cents: 8999 }, 8999)).not.toBeNull();
    expect(check({ ...ok, proposal: { ...ok.proposal, remedy: "refund_partial", amount_cents: 4500 } }).ok).toBe(true);
  });
  it("flags verdicts, scores, legal advice, binding or pressuring language in both languages", () => {
    for (const bad of ["This is our decision.", "She is not credible.", "Il est menteur.", "There is a 70% chance.", "Vous êtes légalement tenu de payer.", "This is final and binding.", "Last chance to accept.", "La loi vous oblige à rembourser."]) {
      expect(agentTextProblem(bad), bad).not.toBeNull();
    }
    expect(agentTextProblem("Proposition non contraignante : remboursement du prix payé.")).toBeNull();
    expect(check({ ...ok, proposal: { ...ok.proposal, rationale_claims: [{ text: "This is our decision.", citation_ids: ["C1"] }] } }).ok).toBe(false);
  });
});

describe("party-facing proposal text", () => {
  it("is fixed bilingual wording with the amount, and states it is not binding or legal advice", () => {
    const fr = renderProposal({ remedy: "refund_partial", amount_cents: 4500 }, 8999, "complainant", "fr-CA");
    const en = renderProposal({ remedy: "refund_partial", amount_cents: 4500 }, 8999, "respondent", "en-CA");
    expect(fr).toMatch(/^Proposition pour régler votre demande : le commerçant rembourse 45,00\s\$/);
    expect(fr).toContain("n’est pas contraignante");
    expect(en).toMatch(/^Proposal to settle the claim made against your business: the business refunds \$45\.00\./);
    expect(en).toContain("not legal advice");
    expect(fr).toContain("ne constitue pas un avis juridique");
  });
});

describe("program rules", () => {
  it("stays off unless every rule is configured, with no defaults", () => {
    expect(caseAgentProgram({})).toEqual({ ok: false, missing: ["AEQUITAS_CASE_AGENT_ENABLED"] });
    const partial = caseAgentProgram({ AEQUITAS_CASE_AGENT_ENABLED: "true", AEQUITAS_CASE_AGENT_MAX_AMOUNT_CENTS: "500000" });
    expect(partial.ok).toBe(false);
    expect(!partial.ok && partial.missing).toEqual([
      "AEQUITAS_CASE_AGENT_MAX_MODEL_CALLS_PER_UTC_DAY",
      "AEQUITAS_CASE_AGENT_INTAKE_DAYS",
      "AEQUITAS_CASE_AGENT_RESPONSE_DAYS",
      "AEQUITAS_CASE_AGENT_RESPONDENT_MAY_WITHDRAW",
      "AEQUITAS_CASE_AGENT_CONSENT_ONLY_RESOLUTION",
      "AEQUITAS_CASE_AGENT_PROCESSING_NOTICE_EN",
      "AEQUITAS_CASE_AGENT_PROCESSING_NOTICE_FR",
      "configured Gemini project or Workers AI account and model",
    ]);
    const configured = {
      AEQUITAS_CASE_AGENT_ENABLED: "true",
      AEQUITAS_CASE_AGENT_MAX_AMOUNT_CENTS: "500000",
      AEQUITAS_CASE_AGENT_MAX_MODEL_CALLS_PER_UTC_DAY: "100",
      AEQUITAS_CASE_AGENT_INTAKE_DAYS: "7",
      AEQUITAS_CASE_AGENT_RESPONSE_DAYS: "5",
      AEQUITAS_CASE_AGENT_RESPONDENT_MAY_WITHDRAW: "false",
      AEQUITAS_CASE_AGENT_CONSENT_ONLY_RESOLUTION: "false",
      AEQUITAS_PIPELINE_PROVIDER: "gemini",
      GEMINI_PROJECT_ID: "synthetic-project",
      GEMINI_MODEL: "gemini-3.8-flash",
      AEQUITAS_CASE_AGENT_PROCESSING_NOTICE_EN: "Synthetic English provider notice.",
      AEQUITAS_CASE_AGENT_PROCESSING_NOTICE_FR: "Avis synthétique au fournisseur en français.",
    };
    expect(caseAgentProgram(configured)).toMatchObject({ ok: true, program: { respondentMayWithdraw: false, consentOnlyResolution: false, maxModelCallsPerUtcDay: 100 } });
    expect(caseAgentProgram({ ...configured, AEQUITAS_CASE_AGENT_CONSENT_ONLY_RESOLUTION: "yes" }).ok).toBe(false);
    expect(caseAgentProgram({ ...configured, AEQUITAS_CASE_AGENT_INTAKE_DAYS: "0" }).ok).toBe(false);
    expect(caseAgentProgram({ ...configured, AEQUITAS_CASE_AGENT_MAX_MODEL_CALLS_PER_UTC_DAY: "0" }).ok).toBe(false);
    expect(caseAgentProgram({ ...configured, AEQUITAS_CASE_AGENT_MAX_MODEL_CALLS_PER_UTC_DAY: "2147483648" }).ok).toBe(false);
    expect(caseAgentProgram({ ...configured, AEQUITAS_CASE_AGENT_PROCESSING_NOTICE_EN: "x".repeat(3001) }).ok).toBe(false);
  });
});
