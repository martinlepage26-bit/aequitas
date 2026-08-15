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
