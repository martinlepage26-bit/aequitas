import type { CaseState, ConsentState, GlobalRole } from "../generated/prisma";
import { ALL_STATES, TRANSITIONS, type Trigger } from "./stateMachine";

/**
 * Section 10: "Every case workspace header renders, for the current viewer:
 * role, authority ('You can: submit evidence'), and next action ('Waiting
 * on: respondent's position'). This is derived from the state machine + role,
 * never hardcoded copy. Implement getAuthorityView(state, role, case) as a
 * pure function with unit tests for every state x role pair."
 *
 * Returns message *keys* (workspace.role.*, workspace.action.*), not
 * literal strings — Section 12 requires every user-facing string to go
 * through the next-intl catalogs (fr-CA/en-CA parity is CI-enforced), and a
 * "pure function" that returned English prose directly would violate that
 * the moment it rendered. The UI layer resolves these keys via useTranslations.
 *
 * "case" (the third arg per Section 10's signature) is CaseProgress below —
 * only the per-party completion flags this function actually needs to name
 * a specific pending party, not the full Prisma Case row. This keeps the
 * function's dependency surface honest (it doesn't need complainantId/etc,
 * since callers already know the viewer's role relative to this case before
 * they ever call it — see Section 4's authorize-before-guard ordering).
 */

export type AuthorityRoleKey = "complainant" | "respondent" | "caseManager" | "admin";

export type AuthorityActionKey =
  | "submitCase"
  | "openIntake"
  | "submitEvidence"
  | "supersedeEvidence"
  | "closeIntake"
  | "submitPosition"
  | "requestDraft"
  | "issueRecommendation"
  | "giveConsent"
  | "declineConsent"
  | "revokeConsent"
  | "requestNewVersion"
  | "closeCase"
  | "withdraw";

/**
 * Per-party progress the M2 states (EVIDENCE_INTAKE, POSITIONS) need to name
 * a specific waiting party precisely (Section 10's example: "Waiting on:
 * respondent's position", not the vaguer "waiting on: complainant or respondent").
 * ISSUED/RESOLVED_CONSENT need the same precision for consent (M4): each
 * party's own consent state on the CURRENT recommendation, not just
 * case-level state, decides whether they see give/decline or revoke.
 */
export interface CaseProgress {
  complainantHasCleanEvidence: boolean;
  respondentHasCleanEvidence: boolean;
  complainantHasCurrentPosition: boolean;
  respondentHasCurrentPosition: boolean;
  complainantConsentState: ConsentState;
  respondentConsentState: ConsentState;
}

export interface WaitingOn {
  roleKey: AuthorityRoleKey | "bothParties" | "system";
  actionKey: AuthorityActionKey | "completeDraft";
}

export interface AuthorityView {
  roleKey: AuthorityRoleKey;
  actionKeys: AuthorityActionKey[];
  waitingOn: WaitingOn | null;
}

function toRoleKey(role: GlobalRole): AuthorityRoleKey {
  switch (role) {
    case "COMPLAINANT":
      return "complainant";
    case "RESPONDENT":
      return "respondent";
    case "CASE_MANAGER":
      return "caseManager";
    case "ADMIN":
      return "admin";
  }
}

/**
 * Trigger names are snake_case in the state machine (Section 6's own
 * naming); AuthorityActionKey is camelCase to match next-intl message-key
 * conventions elsewhere in this codebase. An explicit map, not a type cast —
 * `"open_intake" as AuthorityActionKey` type-checks but does not transform
 * the string, so every `has()` lookup would silently miss.
 */
const TRIGGER_TO_ACTION_KEY: Partial<Record<Trigger, AuthorityActionKey>> = {
  submit_case: "submitCase",
  open_intake: "openIntake",
  submit_evidence: "submitEvidence",
  supersede_evidence: "supersedeEvidence",
  close_intake: "closeIntake",
  submit_position: "submitPosition",
  request_draft: "requestDraft",
  issue_recommendation: "issueRecommendation",
  give_consent: "giveConsent",
  decline_consent: "declineConsent",
  revoke_consent: "revokeConsent",
  request_new_version: "requestNewVersion",
  close_case: "closeCase",
  // create_case: from=NONE, never matches a CaseState. draft_completed:
  // SYSTEM-only, excluded below. withdraw: handled separately by the caller.
};

/**
 * Every non-SYSTEM trigger reachable from `state`, restricted to the roles
 * actually allowed to fire it — the state-machine-derived half of
 * "authority". `withdraw`'s ANY_EXCEPT_CLOSED scope is handled by the
 * caller (it's a COMPLAINANT-only standing capability layered on top of
 * whatever the current state's own triggers allow, not itself state-scoped
 * to one row).
 */
function triggerRolesFromState(state: CaseState): Partial<Record<AuthorityActionKey, GlobalRole[]>> {
  const result: Partial<Record<AuthorityActionKey, GlobalRole[]>> = {};
  for (const def of TRANSITIONS) {
    if (def.actorRoles === "SYSTEM") continue; // never a human authority/waiting-on target
    if (def.trigger === "withdraw") continue; // handled separately, not state-row-scoped
    const actionKey = TRIGGER_TO_ACTION_KEY[def.trigger];
    if (!actionKey) continue;
    const from = def.from === "NONE" ? [] : def.from === "ANY_EXCEPT_CLOSED" ? ALL_STATES.filter((s) => s !== "CLOSED") : def.from;
    if (from.includes(state)) {
      result[actionKey] = def.actorRoles;
    }
  }
  return result;
}

const ROLE_ORDER: GlobalRole[] = ["COMPLAINANT", "RESPONDENT", "CASE_MANAGER", "ADMIN"];

function firstRequiredRole(roles: GlobalRole[]): AuthorityRoleKey | "bothParties" {
  const complainant = roles.includes("COMPLAINANT");
  const respondent = roles.includes("RESPONDENT");
  if (complainant && respondent) return "bothParties";
  return toRoleKey(roles.find((r) => ROLE_ORDER.includes(r))!);
}

export function getAuthorityView(state: CaseState, role: GlobalRole, progress: CaseProgress): AuthorityView {
  const roleKey = toRoleKey(role);
  const available = triggerRolesFromState(state);
  const actionKeys: AuthorityActionKey[] = [];
  let waitingOn: WaitingOn | null = null;

  const has = (trigger: AuthorityActionKey) => available[trigger]?.includes(role) ?? false;

  switch (state) {
    case "DRAFT":
      if (has("submitCase")) actionKeys.push("submitCase");
      else waitingOn = { roleKey: "complainant", actionKey: "submitCase" };
      break;

    case "OPEN":
      if (has("openIntake")) actionKeys.push("openIntake");
      else waitingOn = { roleKey: "caseManager", actionKey: "openIntake" };
      break;

    case "EVIDENCE_INTAKE": {
      if (has("submitEvidence")) actionKeys.push("submitEvidence", "supersedeEvidence");
      // closeIntake is always technically callable by the assigned manager
      // (the override path lets them close without full coverage), so it's
      // shown as an available authority regardless of progress.
      if (has("closeIntake")) actionKeys.push("closeIntake");

      const missing: GlobalRole[] = [];
      if (!progress.complainantHasCleanEvidence) missing.push("COMPLAINANT");
      if (!progress.respondentHasCleanEvidence) missing.push("RESPONDENT");
      if (missing.length > 0) {
        const missingRoleKey = firstRequiredRole(missing);
        if (missingRoleKey !== roleKey) {
          waitingOn = { roleKey: missingRoleKey, actionKey: "submitEvidence" };
        }
      } else if (roleKey !== "caseManager") {
        waitingOn = { roleKey: "caseManager", actionKey: "closeIntake" };
      }
      break;
    }

    case "POSITIONS": {
      if (has("submitPosition")) actionKeys.push("submitPosition");
      const bothPartiesDone = progress.complainantHasCurrentPosition && progress.respondentHasCurrentPosition;
      if (bothPartiesDone && has("requestDraft")) actionKeys.push("requestDraft");

      const missing: GlobalRole[] = [];
      if (!progress.complainantHasCurrentPosition) missing.push("COMPLAINANT");
      if (!progress.respondentHasCurrentPosition) missing.push("RESPONDENT");
      if (missing.length > 0) {
        const missingRoleKey = firstRequiredRole(missing);
        if (missingRoleKey !== roleKey) {
          waitingOn = { roleKey: missingRoleKey, actionKey: "submitPosition" };
        }
      } else if (roleKey !== "caseManager") {
        waitingOn = { roleKey: "caseManager", actionKey: "requestDraft" };
      }
      break;
    }

    case "DRAFTING":
      if (has("requestDraft")) actionKeys.push("requestDraft");
      // draft_completed is SYSTEM-only (no human authority); issue_recommendation
      // is the human-facing next step once the system finishes drafting.
      if (has("issueRecommendation")) actionKeys.push("issueRecommendation");
      else waitingOn = { roleKey: "caseManager", actionKey: "issueRecommendation" };
      break;

    case "ISSUED": {
      const ownConsentState = roleKey === "complainant" ? progress.complainantConsentState : progress.respondentConsentState;
      if (has("giveConsent")) {
        if (ownConsentState === "GIVEN") actionKeys.push("revokeConsent");
        else if (ownConsentState !== "DECLINED") actionKeys.push("giveConsent", "declineConsent");
      }
      // A case manager can request a new version once a party has revoked
      // consent (Section 6 row 14's second `from`: "ISSUED after revocation").
      if (has("requestNewVersion")) actionKeys.push("requestNewVersion");

      if (roleKey !== "complainant" && roleKey !== "respondent") {
        const pending: AuthorityRoleKey[] = [];
        if (progress.complainantConsentState !== "GIVEN") pending.push("complainant");
        if (progress.respondentConsentState !== "GIVEN") pending.push("respondent");
        waitingOn =
          pending.length === 2
            ? { roleKey: "bothParties", actionKey: "giveConsent" }
            : pending.length === 1
              ? { roleKey: pending[0], actionKey: "giveConsent" }
              : null;
      }
      break;
    }

    case "RESOLVED_CONSENT":
      if (has("revokeConsent")) actionKeys.push("revokeConsent");
      if (has("closeCase")) actionKeys.push("closeCase");
      else waitingOn = { roleKey: "caseManager", actionKey: "closeCase" };
      break;

    case "RESOLVED_DECLINED":
      if (has("requestNewVersion")) actionKeys.push("requestNewVersion");
      if (has("closeCase")) actionKeys.push("closeCase");
      else waitingOn = { roleKey: "caseManager", actionKey: "closeCase" };
      break;

    case "WITHDRAWN":
      if (has("closeCase")) actionKeys.push("closeCase");
      else waitingOn = { roleKey: "caseManager", actionKey: "closeCase" };
      break;

    case "CLOSED":
      // Terminal: no trigger is reachable from CLOSED (see ALL_STATES.filter
      // in ANY_EXCEPT_CLOSED) — no authority, nothing to wait on.
      break;
  }

  // withdraw: standing COMPLAINANT capability from any non-CLOSED state,
  // layered on top of whatever the state row above already granted.
  if (role === "COMPLAINANT" && state !== "CLOSED") {
    actionKeys.push("withdraw");
  }

  return { roleKey, actionKeys, waitingOn };
}
