import { describe, expect, it } from "vitest";
import * as guards from "../../src/domain/guards";

describe("guards", () => {
  it("authenticated", () => {
    expect(guards.authenticated({ actorId: "u1" })).toEqual({ ok: true });
    expect(guards.authenticated({ actorId: null })).toEqual({ ok: false, reason: "Not authenticated." });
  });

  it("statementVersionsCurrent", () => {
    expect(guards.statementVersionsCurrent({ requestedVersionId: "v1", currentVersionId: "v1" })).toEqual({ ok: true });
    const rejected = guards.statementVersionsCurrent({ requestedVersionId: "v1", currentVersionId: "v2" });
    expect(rejected.ok).toBe(false);
  });

  it("isCaseOwner", () => {
    expect(guards.isCaseOwner({ actorId: "u1", complainantId: "u1" })).toEqual({ ok: true });
    expect(guards.isCaseOwner({ actorId: "u2", complainantId: "u1" }).ok).toBe(false);
  });

  it("requiredIntakeFieldsComplete", () => {
    expect(guards.requiredIntakeFieldsComplete({ missingFields: [] })).toEqual({ ok: true });
    const rejected = guards.requiredIntakeFieldsComplete({ missingFields: ["title"] });
    expect(rejected).toEqual({ ok: false, reason: "Required intake fields are missing: title" });
  });

  it("caseAssignedToManager", () => {
    expect(guards.caseAssignedToManager({ actorId: "m1", caseManagerId: "m1" })).toEqual({ ok: true });
    expect(guards.caseAssignedToManager({ actorId: "m1", caseManagerId: null }).ok).toBe(false);
    expect(guards.caseAssignedToManager({ actorId: "m1", caseManagerId: "m2" }).ok).toBe(false);
  });

  it("caseAssignedToManagerOrUnclaimed", () => {
    expect(guards.caseAssignedToManagerOrUnclaimed({ actorId: "m1", caseManagerId: null })).toEqual({ ok: true });
    expect(guards.caseAssignedToManagerOrUnclaimed({ actorId: "m1", caseManagerId: "m1" })).toEqual({ ok: true });
    expect(guards.caseAssignedToManagerOrUnclaimed({ actorId: "m1", caseManagerId: "m2" }).ok).toBe(false);
  });

  it("coiDeclarationOnFile", () => {
    expect(guards.coiDeclarationOnFile({ declared: true, hasConflict: false })).toEqual({ ok: true });
    expect(guards.coiDeclarationOnFile({ declared: false, hasConflict: false }).ok).toBe(false);
    expect(guards.coiDeclarationOnFile({ declared: true, hasConflict: true }).ok).toBe(false);
  });

  it("isCaseParty", () => {
    const ctx = { complainantId: "c1", respondentId: "r1" };
    expect(guards.isCaseParty({ actorId: "c1", ...ctx })).toEqual({ ok: true });
    expect(guards.isCaseParty({ actorId: "r1", ...ctx })).toEqual({ ok: true });
    expect(guards.isCaseParty({ actorId: "outsider", ...ctx }).ok).toBe(false);
  });

  it("supersedesOwnItem", () => {
    expect(guards.supersedesOwnItem({ actorId: "u1", priorItemSubmittedById: "u1" })).toEqual({ ok: true });
    expect(guards.supersedesOwnItem({ actorId: "u1", priorItemSubmittedById: "u2" }).ok).toBe(false);
  });

  it("atLeastOneEvidenceItemPerPartyOrOverride", () => {
    expect(guards.atLeastOneEvidenceItemPerPartyOrOverride({ complainantHasEvidence: true, respondentHasEvidence: true })).toEqual({ ok: true });
    expect(
      guards.atLeastOneEvidenceItemPerPartyOrOverride({ complainantHasEvidence: false, respondentHasEvidence: true, overrideReason: "retailer non-responsive" })
    ).toEqual({ ok: true });
    expect(guards.atLeastOneEvidenceItemPerPartyOrOverride({ complainantHasEvidence: true, respondentHasEvidence: false }).ok).toBe(false);
    expect(
      guards.atLeastOneEvidenceItemPerPartyOrOverride({ complainantHasEvidence: false, respondentHasEvidence: false, overrideReason: "  " }).ok
    ).toBe(false);
  });

  it("bothPartiesHaveCurrentPositions", () => {
    expect(guards.bothPartiesHaveCurrentPositions({ complainantHasPosition: true, respondentHasPosition: true })).toEqual({ ok: true });
    expect(guards.bothPartiesHaveCurrentPositions({ complainantHasPosition: true, respondentHasPosition: false }).ok).toBe(false);
  });

  it("explanationRecordValidatesAgainstSchema / explanationRecordValid", () => {
    expect(guards.explanationRecordValidatesAgainstSchema({ schemaValidationError: null })).toEqual({ ok: true });
    expect(guards.explanationRecordValid({ schemaValidationError: "limits must be non-empty" }).ok).toBe(false);
  });

  it("citationsResolveToCaseEvidence", () => {
    const caseEvidenceItemIds = new Set(["e1", "e2"]);
    expect(guards.citationsResolveToCaseEvidence({ citedEvidenceItemIds: ["e1"], caseEvidenceItemIds })).toEqual({ ok: true });
    const rejected = guards.citationsResolveToCaseEvidence({ citedEvidenceItemIds: ["e1", "e-other-case"], caseEvidenceItemIds });
    expect(rejected).toEqual({ ok: false, reason: "Recommendation cites evidence not in this case: e-other-case" });
  });

  it("reviewerIsIssuingManager delegates to caseAssignedToManager", () => {
    expect(guards.reviewerIsIssuingManager({ actorId: "m1", caseManagerId: "m1" })).toEqual({ ok: true });
    expect(guards.reviewerIsIssuingManager({ actorId: "m1", caseManagerId: "m2" }).ok).toBe(false);
  });

  it("consentBindsToCurrentRecommendationVersion", () => {
    expect(guards.consentBindsToCurrentRecommendationVersion({ targetRecommendationId: "r1", currentRecommendationId: "r1" })).toEqual({ ok: true });
    expect(guards.consentBindsToCurrentRecommendationVersion({ targetRecommendationId: "r1", currentRecommendationId: "r2" }).ok).toBe(false);
  });

  it("isConsentingParty", () => {
    expect(guards.isConsentingParty({ actorId: "c1", consentPartyId: "c1" })).toEqual({ ok: true });
    expect(guards.isConsentingParty({ actorId: "c1", consentPartyId: "c2" }).ok).toBe(false);
  });

  it("caseNotClosed", () => {
    expect(guards.caseNotClosed({ state: "ISSUED" })).toEqual({ ok: true });
    expect(guards.caseNotClosed({ state: "CLOSED" }).ok).toBe(false);
  });

  it("newVersionNumber", () => {
    expect(guards.newVersionNumber({ requestedVersion: 2, currentMaxVersion: 1 })).toEqual({ ok: true });
    expect(guards.newVersionNumber({ requestedVersion: 3, currentMaxVersion: 1 }).ok).toBe(false);
  });

  it("priorRecommendationSuperseded", () => {
    expect(guards.priorRecommendationSuperseded({ priorRecommendationStatus: "ISSUED" })).toEqual({ ok: true });
    expect(guards.priorRecommendationSuperseded({ priorRecommendationStatus: "SUPERSEDED" }).ok).toBe(false);
  });

  it("exportBundleGeneratedAndHashed", () => {
    expect(guards.exportBundleGeneratedAndHashed({ exportSha256: "abc123" })).toEqual({ ok: true });
    expect(guards.exportBundleGeneratedAndHashed({ exportSha256: null }).ok).toBe(false);
  });

  it("descriptive no-op guards always pass", () => {
    expect(guards.evidenceVisibilityRequiresCleanScan({})).toEqual({ ok: true });
    expect(guards.oneCurrentVersionPerParty({})).toEqual({ ok: true });
  });

  it("every guard returns a reason string on failure", () => {
    const failures: guards.GuardResult[] = [
      guards.authenticated({ actorId: null }),
      guards.isCaseOwner({ actorId: "a", complainantId: "b" }),
      guards.caseNotClosed({ state: "CLOSED" }),
    ];
    for (const result of failures) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(typeof result.reason).toBe("string");
    }
  });
});
