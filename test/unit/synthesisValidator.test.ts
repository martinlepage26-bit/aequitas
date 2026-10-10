import { describe, expect, it } from "vitest";
import { absoluteClaimHit } from "../../src/domain/pipeline/absoluteClaims";
import { assembleSynthesis, validateSynthesis, type SynthesisDraft } from "../../src/domain/pipeline/synthesis";

const disputed = {
  id: "claim-disputed",
  text: "The delivery note and the invoice do not name the same date.",
  claimType: "FACTUAL",
  confidence: "DISPUTED",
  status: "DISPUTED",
  doNotSummarizeAsSettled: false,
};

const sourceId = "source-1";

function contextFor(claims = [disputed]) {
  return { claims, sourceIds: new Set([sourceId]) };
}

describe("synthesis validator", () => {
  it("rejects a material sentence with no provenance link", () => {
    const draft = assembleSynthesis({ claims: [disputed], links: [{ claimId: disputed.id, sourceId, excerpt: "2 March" }], hasContextFactor: false });
    draft.sections.established.push({ id: "loose", text: "A further sentence sits in the file with no link." });
    const result = validateSynthesis(draft, contextFor());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons.join(" ")).toMatch(/no provenance link/);
  });

  it("puts a referenced disputed claim in the disputed section", () => {
    const draft = assembleSynthesis({
      claims: [disputed],
      links: [{ claimId: disputed.id, sourceId, excerpt: "2 March" }],
      hasContextFactor: false,
    });
    expect(draft.sections.disputed.map((sentence) => sentence.text)).toContain(disputed.text);
    expect(draft.sections.established).toEqual([]);
    expect(validateSynthesis(draft, contextFor()).ok).toBe(true);
    expect(draft.diag_e).toBe("disputed_present");
    expect(typeof draft.diag_e).toBe("string");
    expect(typeof draft.diag_p).toBe("string");
    expect(typeof draft.diag_c).toBe("string");
  });

  it("rejects a synthesis that references a disputed claim outside the disputed section", () => {
    const draft: SynthesisDraft = {
      sections: {
        established: [{ id: "s-1", text: disputed.text }],
        disputed: [],
        unknown: [],
        actionable: [],
        reviewable: [],
      },
      sentence_map: [{ sentenceId: "s-1", claimIds: [disputed.id], sourceIds: [sourceId] }],
      diag_e: "disputed_present",
      diag_p: "positionality_gap",
      diag_c: "third_factor_missing",
    };
    const result = validateSynthesis(draft, contextFor());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons.join(" ")).toMatch(/disputed section/);
  });

  it("rejects numeric diagnostic values", () => {
    const draft = assembleSynthesis({
      claims: [disputed],
      links: [{ claimId: disputed.id, sourceId, excerpt: "2 March" }],
      hasContextFactor: true,
    });
    const result = validateSynthesis({ ...draft, diag_e: 0.8 }, contextFor());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons.join(" ")).toMatch(/not numeric scores/);
  });

  it("rejects an absolute claim in a sentence", () => {
    const draft = assembleSynthesis({
      claims: [{ ...disputed, confidence: "ESTABLISHED", status: "OPEN", text: "The file shows the merchant was impartial." }],
      links: [{ claimId: disputed.id, sourceId, excerpt: "2 March" }],
      hasContextFactor: false,
    });
    const result = validateSynthesis(draft, contextFor([{ ...disputed, confidence: "ESTABLISHED", status: "OPEN" }]));
    expect(result.ok).toBe(false);
  });
});

describe("absolute claim guard", () => {
  it("blocks the P7 phrases", () => {
    expect(absoluteClaimHit("The party is impartial.")).toBeTruthy();
    expect(absoluteClaimHit("100% compliant with the policy")).toBeTruthy();
    expect(absoluteClaimHit("no bias was found")).toBeTruthy();
    expect(absoluteClaimHit("The delivery note names 2 March.")).toBeNull();
  });
});
