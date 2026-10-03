import type { CaseState, GlobalRole, EventType } from "../generated/prisma";

/**
 * Declarative transition table — aequitas-implementation-handoff.md Section 6.
 * This is the spec; src/domain/guards.ts and the mutation pipeline
 * (src/domain/mutate.ts) must not encode transition logic anywhere else.
 * The exhaustive (state, trigger, role) unit test iterates this table.
 */

export const TRIGGERS = [
  "create_case",
  "submit_case",
  "open_intake",
  "submit_evidence",
  "submit_chronology",
  "supersede_evidence",
  "close_intake",
  "submit_position",
  "request_draft",
  "draft_completed",
  "review_draft",
  "issue_recommendation",
  "give_consent",
  "decline_consent",
  "revoke_consent",
  "request_new_version",
  "withdraw",
  "close_case",
] as const;

export type Trigger = (typeof TRIGGERS)[number];

/** No case exists yet (create_case only). */
export const NONE = "NONE" as const;
/** Every CaseState except CLOSED (withdraw only). */
export const ANY_EXCEPT_CLOSED = "ANY_EXCEPT_CLOSED" as const;

/**
 * give_consent's resulting case state depends on whether this consent
 * completes both parties' GIVEN state — Section 6's own header note:
 * "the case-level RESOLVED_* states are derived when consent outcomes
 * complete." The mutation pipeline resolves DERIVED via deriveGiveConsentState().
 */
export const DERIVED = "DERIVED" as const;

/**
 * Coarse, role-level actor eligibility. Case-instance-specific checks
 * ("this party's own item", "the consenting party") are guards, not part
 * of the transition table — see Section 4: "authorize (role + case
 * assignment) -> evaluate guard" are separate pipeline steps.
 */
export const SYSTEM = "SYSTEM" as const;

export interface TransitionDef {
  trigger: Trigger;
  from: CaseState[] | typeof NONE | typeof ANY_EXCEPT_CLOSED;
  to: CaseState | typeof DERIVED;
  actorRoles: GlobalRole[] | typeof SYSTEM;
  guards: string[];
  events: EventType[];
}

const ALL_STATES: CaseState[] = [
  "DRAFT",
  "OPEN",
  "EVIDENCE_INTAKE",
  "POSITIONS",
  "DRAFTING",
  "ISSUED",
  "RESOLVED_CONSENT",
  "RESOLVED_DECLINED",
  "WITHDRAWN",
  "CLOSED",
];

export const TRANSITIONS: TransitionDef[] = [
  {
    trigger: "create_case",
    from: NONE,
    to: "DRAFT",
    actorRoles: ["COMPLAINANT"],
    guards: ["authenticated", "statementVersionsCurrent"],
    events: ["CASE_CREATED"],
  },
  {
    trigger: "submit_case",
    from: ["DRAFT"],
    to: "OPEN",
    actorRoles: ["COMPLAINANT"],
    guards: ["isCaseOwner", "requiredIntakeFieldsComplete"],
    events: ["CASE_SUBMITTED", "PARTY_NOTIFIED"],
  },
  {
    trigger: "open_intake",
    from: ["OPEN"],
    to: "EVIDENCE_INTAKE",
    actorRoles: ["CASE_MANAGER"],
    // caseAssignedToManagerOrUnclaimed (not the strict caseAssignedToManager
    // used elsewhere): Section 16 defines no assignment endpoint, so the
    // case manager self-claims an unassigned case by calling open_intake.
    guards: ["caseAssignedToManagerOrUnclaimed", "coiDeclarationOnFile"],
    // Section 6's own "Events emitted" column says "coi.verified", which
    // does not exist in Section 8's canonical EventType catalogue (only
    // "coi.declared" does — doc drift, resolved in favor of Section 8,
    // the section that states it IS the canonical list). CASE_ASSIGNED
    // (also in Section 8's catalogue, otherwise unused by any Section 6
    // row) is emitted here instead, since self-claim is this build's
    // resolution to the undefined-assignment gap. See DECISIONS.md.
    events: ["EVIDENCE_INTAKE_OPENED", "CASE_ASSIGNED"],
  },
  {
    trigger: "submit_evidence",
    from: ["EVIDENCE_INTAKE"],
    to: "EVIDENCE_INTAKE",
    actorRoles: ["COMPLAINANT", "RESPONDENT"],
    guards: ["isCaseParty", "evidenceVisibilityRequiresCleanScan"],
    events: ["EVIDENCE_SUBMITTED"],
  },
  {
    trigger: "supersede_evidence",
    from: ["EVIDENCE_INTAKE"],
    to: "EVIDENCE_INTAKE",
    actorRoles: ["COMPLAINANT", "RESPONDENT"],
    guards: ["isCaseParty", "supersedesOwnItem"],
    events: ["EVIDENCE_SUPERSEDED"],
  },
  {
    trigger: "submit_chronology",
    from: ["EVIDENCE_INTAKE"],
    to: "EVIDENCE_INTAKE",
    actorRoles: ["COMPLAINANT", "RESPONDENT"],
    guards: ["isCaseParty"],
    events: ["CHRONOLOGY_ENTRY_SUBMITTED"],
  },
  {
    trigger: "close_intake",
    from: ["EVIDENCE_INTAKE"],
    to: "POSITIONS",
    actorRoles: ["CASE_MANAGER"],
    guards: ["caseAssignedToManager", "atLeastOneEvidenceItemPerPartyOrOverride"],
    events: ["EVIDENCE_INTAKE_CLOSED"],
  },
  {
    trigger: "submit_position",
    from: ["POSITIONS"],
    to: "POSITIONS",
    actorRoles: ["COMPLAINANT", "RESPONDENT"],
    guards: ["isCaseParty", "oneCurrentVersionPerParty"],
    events: ["POSITION_SUBMITTED"],
  },
  {
    trigger: "request_draft",
    from: ["POSITIONS", "DRAFTING"],
    to: "DRAFTING",
    actorRoles: ["CASE_MANAGER"],
    guards: ["caseAssignedToManager", "bothPartiesHaveCurrentPositions", "coiDeclarationOnFile"],
    events: ["RECOMMENDATION_DRAFT_REQUESTED"],
  },
  {
    trigger: "draft_completed",
    from: ["DRAFTING"],
    to: "DRAFTING",
    actorRoles: SYSTEM,
    guards: ["explanationRecordValidatesAgainstSchema"],
    events: ["RECOMMENDATION_DRAFTED"],
  },
  {
    trigger: "review_draft",
    from: ["DRAFTING"],
    to: "DRAFTING",
    actorRoles: ["CASE_MANAGER"],
    guards: ["caseAssignedToManager", "explanationRecordValid"],
    events: ["RECOMMENDATION_DRAFTED", "NOTE_ADDED"],
  },
  {
    trigger: "issue_recommendation",
    from: ["DRAFTING"],
    to: "ISSUED",
    actorRoles: ["CASE_MANAGER"],
    guards: ["caseAssignedToManager", "explanationRecordValid", "citationsResolveToCaseEvidence", "reviewerIsIssuingManager"],
    events: ["RECOMMENDATION_ISSUED", "PARTY_NOTIFIED"],
  },
  {
    trigger: "give_consent",
    from: ["ISSUED"],
    to: DERIVED,
    actorRoles: ["COMPLAINANT", "RESPONDENT"],
    guards: ["isCaseParty", "consentBindsToCurrentRecommendationVersion", "statementVersionIsCurrent"],
    events: ["CONSENT_GIVEN"],
  },
  {
    trigger: "decline_consent",
    from: ["ISSUED"],
    to: "RESOLVED_DECLINED",
    actorRoles: ["COMPLAINANT", "RESPONDENT"],
    guards: ["isCaseParty"],
    events: ["CONSENT_DECLINED", "CASE_RESOLVED_DECLINED"],
  },
  {
    trigger: "revoke_consent",
    from: ["ISSUED", "RESOLVED_CONSENT"],
    to: "ISSUED",
    actorRoles: ["COMPLAINANT", "RESPONDENT"],
    guards: ["isConsentingParty", "caseNotClosed"],
    events: ["CONSENT_REVOKED", "CASE_REOPENED"],
  },
  {
    trigger: "request_new_version",
    from: ["RESOLVED_DECLINED", "ISSUED"],
    to: "DRAFTING",
    actorRoles: ["CASE_MANAGER"],
    guards: ["caseAssignedToManager", "newVersionNumber", "priorRecommendationSuperseded"],
    events: ["RECOMMENDATION_DRAFT_REQUESTED"],
  },
  {
    trigger: "withdraw",
    from: ANY_EXCEPT_CLOSED,
    to: "WITHDRAWN",
    actorRoles: ["COMPLAINANT"],
    guards: ["isCaseOwner"],
    events: ["CASE_WITHDRAWN", "PARTY_NOTIFIED"],
  },
  {
    trigger: "close_case",
    from: ["RESOLVED_CONSENT", "RESOLVED_DECLINED", "WITHDRAWN"],
    to: "CLOSED",
    actorRoles: ["CASE_MANAGER"],
    guards: ["caseAssignedToManager", "exportBundleGeneratedAndHashed"],
    events: ["EXPORT_GENERATED", "CASE_CLOSED"],
  },
];

export function transitionsFor(trigger: Trigger): TransitionDef {
  const def = TRANSITIONS.find((t) => t.trigger === trigger);
  if (!def) throw new Error(`Unknown trigger: ${trigger}`);
  return def;
}

export function allowedFromStates(def: TransitionDef): CaseState[] {
  if (def.from === NONE) return [];
  if (def.from === ANY_EXCEPT_CLOSED) return ALL_STATES.filter((s) => s !== "CLOSED");
  return def.from;
}

export function isFromStateAllowed(def: TransitionDef, state: CaseState | typeof NONE): boolean {
  if (def.from === NONE) return state === NONE;
  if (state === NONE) return false;
  return allowedFromStates(def).includes(state);
}

export function isActorRoleAllowed(def: TransitionDef, role: GlobalRole | typeof SYSTEM): boolean {
  if (def.actorRoles === SYSTEM) return role === SYSTEM;
  if (role === SYSTEM) return false;
  return def.actorRoles.includes(role);
}

export { ALL_STATES };
