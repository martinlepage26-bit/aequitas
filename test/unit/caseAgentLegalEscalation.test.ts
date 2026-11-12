import { describe, expect, it } from "vitest";
import { hasExplicitLegalIssueMarker } from "../../src/domain/caseAgent/legalEscalation";

describe("explicit legal-issue handoff backstop", () => {
  it.each([
    "I want to know whether the statutory warranty under Québec consumer law covers this defect.",
    "Does the Consumer Protection Act apply to my purchase?",
    "I need legal advice about my rights.",
    "Est-ce que la garantie légale prévue par la Loi sur la protection du consommateur s’applique à ma situation?",
    "Je demande une interprétation juridique de mes droits.",
  ])("detects explicit legal language: %s", (text) => {
    expect(hasExplicitLegalIssueMarker([text])).toBe(true);
  });

  it.each([
    "The manufacturer's warranty expired after 12 months; we declined the claim.",
    "The customer reports that the kettle stopped heating after three days.",
    "The store offered a replacement for the same model.",
  ])("does not escalate ordinary retail facts by themselves: %s", (text) => {
    expect(hasExplicitLegalIssueMarker([text])).toBe(false);
  });

  it("handles empty input and normalizes French accents", () => {
    expect(hasExplicitLegalIssueMarker([null, undefined, "", "Garantie LEGALE"])).toBe(true);
    expect(hasExplicitLegalIssueMarker([null, undefined, ""])).toBe(false);
  });
});
