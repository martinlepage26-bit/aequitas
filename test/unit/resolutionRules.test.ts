import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { APPROVAL_FAILURE_CODES, BLOCKER_REASONS, RESOLUTION_BLOCKERS, checkApproval, consentAloneResolves, partyFacingBlockers, resolutionBlockers } from "../../src/domain/resolution";
import { resolutionNotBlocked } from "../../src/domain/guards";
import { transitionsFor } from "../../src/domain/stateMachine";

const baseCase = { complainantId: "c", respondentId: "r", caseManagerId: "m", state: "ISSUED" as const, currentRecommendationId: "rec" };
const baseInput = {
  approver: { id: "a", globalRole: "CASE_MANAGER" as const, isApprover: true },
  caseRow: baseCase,
  recommendationIssuedById: "m",
  latestSynthesisAuthorId: null,
  rationale: "ok",
  openContestations: 0,
  alreadyApproved: false,
};

describe("resolution blockers", () => {
  it("does not treat agent enrollment as an approval waiver unless the case records that explicit policy", () => {
    expect(consentAloneResolves({ consentOnlyResolution: false, agentManaged: true })).toBe(false);
    expect(consentAloneResolves({ consentOnlyResolution: false, agentManaged: true, agentConsentOnlyResolution: true })).toBe(true);
    expect(consentAloneResolves({ consentOnlyResolution: false, agentManaged: true, agentConsentOnlyResolution: true, agentEscalatedAt: new Date() })).toBe(false);
    expect(consentAloneResolves({ consentOnlyResolution: true, agentManaged: true, agentConsentOnlyResolution: false })).toBe(false);
    expect(consentAloneResolves({ consentOnlyResolution: true, agentManaged: false })).toBe(true);
  });

  it("consent-only cases need no sign-off; new cases do", () => {
    expect(resolutionBlockers({ consentOnlyResolution: true, openContestations: 0, approvedForCurrentRecommendation: false })).toEqual([]);
    expect(resolutionBlockers({ consentOnlyResolution: false, openContestations: 0, approvedForCurrentRecommendation: false })).toEqual(["APPROVAL_REQUIRED"]);
    expect(resolutionBlockers({ consentOnlyResolution: false, openContestations: 0, approvedForCurrentRecommendation: true })).toEqual([]);
  });

  it("an open contestation blocks every case", () => {
    expect(resolutionBlockers({ consentOnlyResolution: true, openContestations: 1, approvedForCurrentRecommendation: false })).toEqual(["OPEN_CONTESTATION"]);
    expect(resolutionBlockers({ consentOnlyResolution: false, openContestations: 2, approvedForCurrentRecommendation: true })).toEqual(["OPEN_CONTESTATION"]);
  });

  it("uses one pause notice when another party's contestation is open", () => {
    expect(partyFacingBlockers(["OPEN_CONTESTATION", "APPROVAL_REQUIRED"], 1)).toEqual(["RESOLUTION_PAUSED", "APPROVAL_REQUIRED"]);
    expect(partyFacingBlockers(["APPROVAL_REQUIRED"], 1)).toEqual(["RESOLUTION_PAUSED", "APPROVAL_REQUIRED"]);
    expect(partyFacingBlockers(["OPEN_CONTESTATION"], 1)).toEqual(["RESOLUTION_PAUSED"]);
    expect(partyFacingBlockers(["OPEN_CONTESTATION"], 0)).toEqual(["OPEN_CONTESTATION"]);
    expect(BLOCKER_REASONS.RESOLUTION_PAUSED).toBe("Resolution paused pending review");
  });

  it("give_consent carries the resolution guard and it returns the code", () => {
    expect(transitionsFor("give_consent").guards).toContain("resolutionNotBlocked");
    expect(resolutionNotBlocked({ blockers: [] })).toEqual({ ok: true });
    expect(resolutionNotBlocked({ blockers: [{ code: "OPEN_CONTESTATION", reason: "r" }] })).toEqual({ ok: false, reason: "r", code: "OPEN_CONTESTATION" });
  });
});

describe("checkApproval separation of duties", () => {
  it("accepts a designated approver who authored nothing on the case", () => {
    expect(checkApproval(baseInput)).toEqual({ ok: true });
  });
  it("rejects the owner, the recommendation author and the synthesis author with SAME_AUTHOR", () => {
    expect(checkApproval({ ...baseInput, approver: { ...baseInput.approver, id: "m" } })).toMatchObject({ ok: false, status: 409, code: "SAME_AUTHOR" });
    expect(checkApproval({ ...baseInput, recommendationIssuedById: "a" })).toMatchObject({ code: "SAME_AUTHOR" });
    expect(checkApproval({ ...baseInput, latestSynthesisAuthorId: "a" })).toMatchObject({ code: "SAME_AUTHOR" });
  });
  it("rejects admins, parties and non-approvers with 403", () => {
    expect(checkApproval({ ...baseInput, approver: { id: "a", globalRole: "ADMIN", isApprover: true } })).toMatchObject({ status: 403, code: "ADMIN_CANNOT_APPROVE" });
    expect(checkApproval({ ...baseInput, approver: { ...baseInput.approver, id: "c" } })).toMatchObject({ status: 403, code: "PARTY_CANNOT_APPROVE" });
    expect(checkApproval({ ...baseInput, approver: { ...baseInput.approver, isApprover: false } })).toMatchObject({ status: 403, code: "NOT_APPROVER" });
  });
  it("needs an issued recommendation, a rationale, no open contestation, and one sign-off per version", () => {
    expect(checkApproval({ ...baseInput, caseRow: { ...baseCase, state: "DRAFTING" } })).toMatchObject({ code: "NO_ISSUED_RECOMMENDATION" });
    expect(checkApproval({ ...baseInput, rationale: null })).toMatchObject({ code: "MISSING_RATIONALE" });
    expect(checkApproval({ ...baseInput, openContestations: 1 })).toMatchObject({ code: "OPEN_CONTESTATION" });
    expect(checkApproval({ ...baseInput, alreadyApproved: true })).toMatchObject({ code: "ALREADY_APPROVED" });
  });
});

describe("fr-CA and en-CA carry every phase 3 string", () => {
  for (const locale of ["fr-CA", "en-CA"]) {
    it(locale, () => {
      const messages = JSON.parse(readFileSync(path.join(process.cwd(), "messages", `${locale}.json`), "utf8"));
      const resolution = messages.workspace.resolution;
      for (const code of [...RESOLUTION_BLOCKERS, "RESOLUTION_PAUSED", ...APPROVAL_FAILURE_CODES, "CONTESTATION_NOT_OPEN", "TARGET_NOT_ON_CASE", "CASE_NOT_CONTESTABLE"]) {
        expect(resolution.code[code], `${locale} code.${code}`).toBeTruthy();
      }
      for (const status of ["OPEN", "RESPONDED", "OVERRULED", "WITHDRAWN"]) expect(resolution.status[status]).toBeTruthy();
      for (const target of ["CLAIM", "SYNTHESIS", "PROPOSAL", "RECOMMENDATION"]) expect(resolution.target[target]).toBeTruthy();
      for (const event of ["CONTESTATION_OPENED", "CONTESTATION_RESPONDED", "CONTESTATION_OVERRULED", "CONTESTATION_WITHDRAWN", "RESOLUTION_APPROVED"]) {
        expect(messages.workspace.timeline.event[event], `${locale} timeline ${event}`).toBeTruthy();
      }
    });
  }
  it("the two locales differ (no untranslated copy)", () => {
    const fr = JSON.parse(readFileSync(path.join(process.cwd(), "messages", "fr-CA.json"), "utf8")).workspace.resolution;
    const en = JSON.parse(readFileSync(path.join(process.cwd(), "messages", "en-CA.json"), "utf8")).workspace.resolution;
    expect(fr.code.OPEN_CONTESTATION).not.toBe(en.code.OPEN_CONTESTATION);
    expect(en.code.RESOLUTION_PAUSED).toBe("Resolution paused pending review");
    expect(fr.code.RESOLUTION_PAUSED).toBe("Règlement suspendu en attendant l'examen.");
    expect(en.code.RESOLUTION_PAUSED).toBe(BLOCKER_REASONS.RESOLUTION_PAUSED);
    expect(fr.title).not.toBe(en.title);
  });
});
