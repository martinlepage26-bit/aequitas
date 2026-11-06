import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { aiGeneratedFieldsSchema, explanationRecordSchema, validateExplanationRecord } from "../../src/domain/explanationRecord";

function validAiFields() {
  return {
    summary: "The product arrived damaged and the retailer declined a refund despite the consumer's timely, documented request.",
    proposed_outcome: "The retailer issues a full refund for the damaged item.",
    reasoning: "The photos submitted by the consumer show visible damage consistent with in-transit mishandling, and the retailer's own position statement does not dispute that the item arrived damaged.",
    evidence_citations: [{ evidence_item_id: randomUUID(), relevance: "Photo showing damage to the item on arrival." }],
    limits: ["This does not account for the item's original condition before shipping, which was not independently verified."],
    not_considered: ["Any prior correspondence between the parties outside this case record was not considered."],
  };
}

function validFullRecord() {
  return {
    ...validAiFields(),
    model: { id: "claude-opus-5", prompt_version: "2026-08-15.1" },
    reviewer: { user_id: null, issued_at: null },
  };
}

describe("explanationRecordSchema — Section 9 hard constraints", () => {
  it("accepts a well-formed record", () => {
    expect(explanationRecordSchema.safeParse(validFullRecord()).success).toBe(true);
  });

  it("aiGeneratedFieldsSchema accepts the AI-only subset (no model/reviewer)", () => {
    expect(aiGeneratedFieldsSchema.safeParse(validAiFields()).success).toBe(true);
  });

  it("rejects empty limits — 'a recommendation that claims no limits is definitionally overclaiming'", () => {
    const record = { ...validFullRecord(), limits: [] };
    const result = explanationRecordSchema.safeParse(record);
    expect(result.success).toBe(false);
  });

  it("rejects empty not_considered", () => {
    const record = { ...validFullRecord(), not_considered: [] };
    expect(explanationRecordSchema.safeParse(record).success).toBe(false);
  });

  it("rejects a non-UUID evidence_item_id", () => {
    const record = { ...validFullRecord(), evidence_citations: [{ evidence_item_id: "not-a-uuid", relevance: "x" }] };
    expect(explanationRecordSchema.safeParse(record).success).toBe(false);
  });

  it("rejects a summary over 120 words", () => {
    const record = { ...validFullRecord(), summary: Array(121).fill("word").join(" ") };
    expect(explanationRecordSchema.safeParse(record).success).toBe(false);
  });

  it("rejects a percentage anywhere in reasoning ('no numeric scores, percentages of fault... anywhere')", () => {
    const record = { ...validFullRecord(), reasoning: "The consumer is 70% at fault for the damage." };
    expect(explanationRecordSchema.safeParse(record).success).toBe(false);
  });

  it("rejects a star-rating pattern in proposed_outcome", () => {
    const record = { ...validFullRecord(), proposed_outcome: "This case merits a 2/5 star rating for the retailer." };
    expect(explanationRecordSchema.safeParse(record).success).toBe(false);
  });

  it("rejects the forbidden term 'decision' (Section 12 glossary, extended to AI output)", () => {
    const record = { ...validFullRecord(), proposed_outcome: "Our decision is that the retailer must refund the consumer." };
    expect(explanationRecordSchema.safeParse(record).success).toBe(false);
  });

  it("allows a plain dollar amount traced to evidence (quantified amounts are explicitly permitted)", () => {
    const record = { ...validFullRecord(), reasoning: "The receipt (cited above) shows the item cost $84.99, which the consumer paid in full." };
    expect(explanationRecordSchema.safeParse(record).success).toBe(true);
  });

  it("rejects a missing model or reviewer block on the full record", () => {
    const { model, ...withoutModel } = validFullRecord();
    void model;
    expect(explanationRecordSchema.safeParse(withoutModel).success).toBe(false);
  });
});

describe("validateExplanationRecord — human-readable message for the guard", () => {
  it("returns null for a valid record", () => {
    expect(validateExplanationRecord(validFullRecord())).toBeNull();
  });

  it("returns a non-null, informative message for an invalid record", () => {
    const message = validateExplanationRecord({ ...validFullRecord(), limits: [] });
    expect(message).not.toBeNull();
    expect(message).toContain("limits");
  });
});

describe("case-agent claim-to-evidence links", () => {
  function linkedRecord() {
    const evidenceId = randomUUID();
    return {
      ...validFullRecord(),
      summary: "The receipt records the paid price.",
      reasoning: "The repair note describes the offered remedy.",
      proposal_reasoning: "The repair note records the offered repair voucher.",
      evidence_citations: [{
        citation_id: "C1",
        evidence_item_id: evidenceId,
        relevance: "Purchase record.",
        extracted_span: {
          start_char: 0,
          end_char: 10,
          source_sha256: "a".repeat(64),
          extracted_text_sha256: "b".repeat(64),
          extraction_method: "utf8" as const,
        },
      }],
      claim_evidence: [
        { section: "summary" as const, text: "The receipt records the paid price.", citation_ids: ["C1"] },
        { section: "reasoning" as const, text: "The repair note describes the offered remedy.", citation_ids: ["C1"] },
        { section: "proposal" as const, text: "The repair note records the offered repair voucher.", citation_ids: ["C1"] },
      ],
    };
  }

  it("accepts a stored claim map whose keys point to citations and whose text appears in its section", () => {
    expect(validateExplanationRecord(linkedRecord())).toBeNull();
  });

  it("requires a proposal-basis claim to appear in the stored proposal reasoning", () => {
    const record = linkedRecord();
    expect(validateExplanationRecord({ ...record, proposal_reasoning: "A different statement." })).toContain("claim text must appear in its proposal section");
  });

  it("rejects a missing or dangling claim-to-citation link", () => {
    const record = linkedRecord();
    expect(validateExplanationRecord({ ...record, claim_evidence: [] })).toContain("claim-to-evidence links");
    expect(validateExplanationRecord({
      ...record,
      claim_evidence: [{ section: "summary", text: record.summary, citation_ids: ["C2"] }],
    })).toContain("unknown citation_id");
  });

  it("requires agent citation IDs to retain verified source offsets", () => {
    const record = linkedRecord();
    const citation = record.evidence_citations[0];
    expect(validateExplanationRecord({
      ...record,
      evidence_citations: [{ citation_id: citation.citation_id, evidence_item_id: citation.evidence_item_id, relevance: citation.relevance }],
    })).toContain("verified extracted span");
  });
});
