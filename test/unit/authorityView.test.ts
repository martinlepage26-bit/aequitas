import { describe, expect, it } from "vitest";
import type { CaseState, GlobalRole } from "../../src/generated/prisma";
import { ALL_STATES } from "../../src/domain/stateMachine";
import { getAuthorityView, type AuthorityView, type CaseProgress } from "../../src/domain/authorityView";

const ROLES: GlobalRole[] = ["COMPLAINANT", "RESPONDENT", "CASE_MANAGER", "ADMIN"];

const NEUTRAL: CaseProgress = {
  complainantHasCleanEvidence: false,
  respondentHasCleanEvidence: false,
  complainantHasCurrentPosition: false,
  respondentHasCurrentPosition: false,
  complainantConsentState: "NOT_GIVEN",
  respondentConsentState: "NOT_GIVEN",
};

/**
 * Ground truth, hand-derived from Section 6's transition table independently
 * of authorityView.ts (same discipline as stateMachine.test.ts's own
 * EXPECTED table) for every state where per-party progress doesn't change
 * the answer. EVIDENCE_INTAKE and POSITIONS depend on CaseProgress and are
 * covered separately below across all four progress permutations.
 */
const EXPECTED: Partial<Record<CaseState, Record<GlobalRole, Omit<AuthorityView, "roleKey">>>> = {
  DRAFT: {
    COMPLAINANT: { actionKeys: ["submitCase", "withdraw"], waitingOn: null },
    RESPONDENT: { actionKeys: [], waitingOn: { roleKey: "complainant", actionKey: "submitCase" } },
    CASE_MANAGER: { actionKeys: [], waitingOn: { roleKey: "complainant", actionKey: "submitCase" } },
    ADMIN: { actionKeys: [], waitingOn: { roleKey: "complainant", actionKey: "submitCase" } },
  },
  OPEN: {
    COMPLAINANT: { actionKeys: ["withdraw"], waitingOn: { roleKey: "caseManager", actionKey: "openIntake" } },
    RESPONDENT: { actionKeys: [], waitingOn: { roleKey: "caseManager", actionKey: "openIntake" } },
    CASE_MANAGER: { actionKeys: ["openIntake"], waitingOn: null },
    ADMIN: { actionKeys: [], waitingOn: { roleKey: "caseManager", actionKey: "openIntake" } },
  },
  DRAFTING: {
    COMPLAINANT: { actionKeys: ["withdraw"], waitingOn: { roleKey: "caseManager", actionKey: "issueRecommendation" } },
    RESPONDENT: { actionKeys: [], waitingOn: { roleKey: "caseManager", actionKey: "issueRecommendation" } },
    CASE_MANAGER: { actionKeys: ["requestDraft", "issueRecommendation"], waitingOn: null },
    ADMIN: { actionKeys: [], waitingOn: { roleKey: "caseManager", actionKey: "issueRecommendation" } },
  },
  ISSUED: {
    COMPLAINANT: { actionKeys: ["giveConsent", "declineConsent", "withdraw"], waitingOn: null },
    RESPONDENT: { actionKeys: ["giveConsent", "declineConsent"], waitingOn: null },
    // request_new_version's `from` includes ISSUED (Section 6 row 14: "...or
    // ISSUED after revocation") — a case manager can request a redraft any
    // time the case is ISSUED, not just after a decline. Eligibility here is
    // role+state only (the neutral fixture's NOT_GIVEN/NOT_GIVEN consent
    // state doesn't gate it); the newVersionNumber/priorRecommendationSuperseded
    // guards enforce real preconditions at mutation time.
    CASE_MANAGER: { actionKeys: ["requestNewVersion"], waitingOn: { roleKey: "bothParties", actionKey: "giveConsent" } },
    ADMIN: { actionKeys: [], waitingOn: { roleKey: "bothParties", actionKey: "giveConsent" } },
  },
  RESOLVED_CONSENT: {
    COMPLAINANT: { actionKeys: ["revokeConsent", "withdraw"], waitingOn: { roleKey: "caseManager", actionKey: "closeCase" } },
    RESPONDENT: { actionKeys: ["revokeConsent"], waitingOn: { roleKey: "caseManager", actionKey: "closeCase" } },
    CASE_MANAGER: { actionKeys: ["closeCase"], waitingOn: null },
    ADMIN: { actionKeys: [], waitingOn: { roleKey: "caseManager", actionKey: "closeCase" } },
  },
  RESOLVED_DECLINED: {
    COMPLAINANT: { actionKeys: ["withdraw"], waitingOn: { roleKey: "caseManager", actionKey: "closeCase" } },
    RESPONDENT: { actionKeys: [], waitingOn: { roleKey: "caseManager", actionKey: "closeCase" } },
    CASE_MANAGER: { actionKeys: ["requestNewVersion", "closeCase"], waitingOn: null },
    ADMIN: { actionKeys: [], waitingOn: { roleKey: "caseManager", actionKey: "closeCase" } },
  },
  WITHDRAWN: {
    // Section 6's own table: withdraw's `from` is ANY_EXCEPT_CLOSED, which
    // literally includes WITHDRAWN itself (a no-op self-loop). This test
    // reflects that literal table rather than silently patching around it —
    // see authorityView.ts's comment on why `withdraw` isn't state-row-scoped.
    COMPLAINANT: { actionKeys: ["withdraw"], waitingOn: { roleKey: "caseManager", actionKey: "closeCase" } },
    RESPONDENT: { actionKeys: [], waitingOn: { roleKey: "caseManager", actionKey: "closeCase" } },
    CASE_MANAGER: { actionKeys: ["closeCase"], waitingOn: null },
    ADMIN: { actionKeys: [], waitingOn: { roleKey: "caseManager", actionKey: "closeCase" } },
  },
  CLOSED: {
    COMPLAINANT: { actionKeys: [], waitingOn: null },
    RESPONDENT: { actionKeys: [], waitingOn: null },
    CASE_MANAGER: { actionKeys: [], waitingOn: null },
    ADMIN: { actionKeys: [], waitingOn: null },
  },
};

function roleKeyFor(role: GlobalRole) {
  return { COMPLAINANT: "complainant", RESPONDENT: "respondent", CASE_MANAGER: "caseManager", ADMIN: "admin" }[role] as
    | "complainant"
    | "respondent"
    | "caseManager"
    | "admin";
}

describe("getAuthorityView — progress-independent states (every state x role pair)", () => {
  const coveredStates = Object.keys(EXPECTED) as CaseState[];

  it("covers every progress-independent state defined in ALL_STATES (EVIDENCE_INTAKE/POSITIONS are tested separately below)", () => {
    const remaining = ALL_STATES.filter((s) => !coveredStates.includes(s));
    expect(new Set(remaining)).toEqual(new Set(["EVIDENCE_INTAKE", "POSITIONS"]));
  });

  for (const state of coveredStates) {
    describe(state, () => {
      for (const role of ROLES) {
        it(`role=${role}`, () => {
          const result = getAuthorityView(state, role, NEUTRAL);
          expect(result).toEqual({ roleKey: roleKeyFor(role), ...EXPECTED[state]![role] });
        });
      }
    });
  }
});

describe("getAuthorityView — EVIDENCE_INTAKE (progress-dependent)", () => {
  const cases: Array<{ label: string; progress: CaseProgress; expected: Record<GlobalRole, Omit<AuthorityView, "roleKey">> }> = [
    {
      label: "neither party has evidence yet",
      progress: { ...NEUTRAL, complainantHasCleanEvidence: false, respondentHasCleanEvidence: false },
      expected: {
        COMPLAINANT: {
          actionKeys: ["submitEvidence", "supersedeEvidence", "submitChronology", "withdraw"],
          waitingOn: { roleKey: "bothParties", actionKey: "submitEvidence" },
        },
        RESPONDENT: {
          actionKeys: ["submitEvidence", "supersedeEvidence", "submitChronology"],
          waitingOn: { roleKey: "bothParties", actionKey: "submitEvidence" },
        },
        CASE_MANAGER: { actionKeys: ["closeIntake"], waitingOn: { roleKey: "bothParties", actionKey: "submitEvidence" } },
        ADMIN: { actionKeys: [], waitingOn: { roleKey: "bothParties", actionKey: "submitEvidence" } },
      },
    },
    {
      label: "consumer has submitted, retailer handler hasn't",
      progress: { ...NEUTRAL, complainantHasCleanEvidence: true, respondentHasCleanEvidence: false },
      expected: {
        COMPLAINANT: {
          actionKeys: ["submitEvidence", "supersedeEvidence", "submitChronology", "withdraw"],
          waitingOn: { roleKey: "respondent", actionKey: "submitEvidence" },
        },
        RESPONDENT: { actionKeys: ["submitEvidence", "supersedeEvidence", "submitChronology"], waitingOn: null },
        CASE_MANAGER: { actionKeys: ["closeIntake"], waitingOn: { roleKey: "respondent", actionKey: "submitEvidence" } },
        ADMIN: { actionKeys: [], waitingOn: { roleKey: "respondent", actionKey: "submitEvidence" } },
      },
    },
    {
      label: "retailer handler has submitted, consumer hasn't",
      progress: { ...NEUTRAL, complainantHasCleanEvidence: false, respondentHasCleanEvidence: true },
      expected: {
        COMPLAINANT: { actionKeys: ["submitEvidence", "supersedeEvidence", "submitChronology", "withdraw"], waitingOn: null },
        RESPONDENT: {
          actionKeys: ["submitEvidence", "supersedeEvidence", "submitChronology"],
          waitingOn: { roleKey: "complainant", actionKey: "submitEvidence" },
        },
        CASE_MANAGER: { actionKeys: ["closeIntake"], waitingOn: { roleKey: "complainant", actionKey: "submitEvidence" } },
        ADMIN: { actionKeys: [], waitingOn: { roleKey: "complainant", actionKey: "submitEvidence" } },
      },
    },
    {
      label: "both parties have submitted clean evidence",
      progress: { ...NEUTRAL, complainantHasCleanEvidence: true, respondentHasCleanEvidence: true },
      expected: {
        COMPLAINANT: {
          actionKeys: ["submitEvidence", "supersedeEvidence", "submitChronology", "withdraw"],
          waitingOn: { roleKey: "caseManager", actionKey: "closeIntake" },
        },
        RESPONDENT: {
          actionKeys: ["submitEvidence", "supersedeEvidence", "submitChronology"],
          waitingOn: { roleKey: "caseManager", actionKey: "closeIntake" },
        },
        CASE_MANAGER: { actionKeys: ["closeIntake"], waitingOn: null },
        ADMIN: { actionKeys: [], waitingOn: { roleKey: "caseManager", actionKey: "closeIntake" } },
      },
    },
  ];

  for (const { label, progress, expected } of cases) {
    describe(label, () => {
      for (const role of ROLES) {
        it(`role=${role}`, () => {
          const result = getAuthorityView("EVIDENCE_INTAKE", role, progress);
          expect(result).toEqual({ roleKey: roleKeyFor(role), ...expected[role] });
        });
      }
    });
  }
});

describe("getAuthorityView — POSITIONS (progress-dependent)", () => {
  const cases: Array<{ label: string; progress: CaseProgress; expected: Record<GlobalRole, Omit<AuthorityView, "roleKey">> }> = [
    {
      label: "neither party has submitted a position yet",
      progress: { ...NEUTRAL, complainantHasCurrentPosition: false, respondentHasCurrentPosition: false },
      expected: {
        COMPLAINANT: { actionKeys: ["submitPosition", "withdraw"], waitingOn: { roleKey: "bothParties", actionKey: "submitPosition" } },
        RESPONDENT: { actionKeys: ["submitPosition"], waitingOn: { roleKey: "bothParties", actionKey: "submitPosition" } },
        CASE_MANAGER: { actionKeys: [], waitingOn: { roleKey: "bothParties", actionKey: "submitPosition" } },
        ADMIN: { actionKeys: [], waitingOn: { roleKey: "bothParties", actionKey: "submitPosition" } },
      },
    },
    {
      label: "consumer has submitted, retailer handler hasn't",
      progress: { ...NEUTRAL, complainantHasCurrentPosition: true, respondentHasCurrentPosition: false },
      expected: {
        COMPLAINANT: {
          actionKeys: ["submitPosition", "withdraw"],
          waitingOn: { roleKey: "respondent", actionKey: "submitPosition" },
        },
        RESPONDENT: { actionKeys: ["submitPosition"], waitingOn: null },
        CASE_MANAGER: { actionKeys: [], waitingOn: { roleKey: "respondent", actionKey: "submitPosition" } },
        ADMIN: { actionKeys: [], waitingOn: { roleKey: "respondent", actionKey: "submitPosition" } },
      },
    },
    {
      label: "retailer handler has submitted, consumer hasn't",
      progress: { ...NEUTRAL, complainantHasCurrentPosition: false, respondentHasCurrentPosition: true },
      expected: {
        COMPLAINANT: { actionKeys: ["submitPosition", "withdraw"], waitingOn: null },
        RESPONDENT: {
          actionKeys: ["submitPosition"],
          waitingOn: { roleKey: "complainant", actionKey: "submitPosition" },
        },
        CASE_MANAGER: { actionKeys: [], waitingOn: { roleKey: "complainant", actionKey: "submitPosition" } },
        ADMIN: { actionKeys: [], waitingOn: { roleKey: "complainant", actionKey: "submitPosition" } },
      },
    },
    {
      label: "both parties have current positions",
      progress: { ...NEUTRAL, complainantHasCurrentPosition: true, respondentHasCurrentPosition: true },
      expected: {
        COMPLAINANT: {
          actionKeys: ["submitPosition", "withdraw"],
          waitingOn: { roleKey: "caseManager", actionKey: "requestDraft" },
        },
        RESPONDENT: {
          actionKeys: ["submitPosition"],
          waitingOn: { roleKey: "caseManager", actionKey: "requestDraft" },
        },
        CASE_MANAGER: { actionKeys: ["requestDraft"], waitingOn: null },
        ADMIN: { actionKeys: [], waitingOn: { roleKey: "caseManager", actionKey: "requestDraft" } },
      },
    },
  ];

  for (const { label, progress, expected } of cases) {
    describe(label, () => {
      for (const role of ROLES) {
        it(`role=${role}`, () => {
          const result = getAuthorityView("POSITIONS", role, progress);
          expect(result).toEqual({ roleKey: roleKeyFor(role), ...expected[role] });
        });
      }
    });
  }
});

describe("getAuthorityView — cross-cutting invariants", () => {
  it("ADMIN never receives an actionable authority, at any state (Section 10 lists no ADMIN capability)", () => {
    for (const state of ALL_STATES) {
      const result = getAuthorityView(state, "ADMIN", {
        complainantHasCleanEvidence: true,
        respondentHasCleanEvidence: true,
        complainantHasCurrentPosition: true,
        respondentHasCurrentPosition: true,
        complainantConsentState: "NOT_GIVEN",
        respondentConsentState: "NOT_GIVEN",
      });
      expect(result.actionKeys, `state=${state}`).toEqual([]);
    }
  });

  it("CLOSED is terminal: no role has any authority or anything to wait on", () => {
    for (const role of ROLES) {
      const result = getAuthorityView("CLOSED", role, NEUTRAL);
      expect(result.actionKeys, role).toEqual([]);
      expect(result.waitingOn, role).toBeNull();
    }
  });

  it("a role that currently holds authority never simultaneously shows a waitingOn pointing at itself", () => {
    for (const state of ALL_STATES) {
      for (const role of ROLES) {
        const result = getAuthorityView(state, role, {
          complainantHasCleanEvidence: false,
          respondentHasCleanEvidence: false,
          complainantHasCurrentPosition: false,
          respondentHasCurrentPosition: false,
          complainantConsentState: "NOT_GIVEN",
          respondentConsentState: "NOT_GIVEN",
        });
        if (result.waitingOn) {
          expect(result.waitingOn.roleKey, `state=${state} role=${role}`).not.toBe(result.roleKey);
        }
      }
    }
  });
});
