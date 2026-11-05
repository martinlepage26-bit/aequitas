import type { CaseState, ConsentState } from "../generated/prisma";

/**
 * Section 7 consent lifecycle, per party per recommendation version:
 *
 *   NOT_GIVEN --give--> GIVEN --revoke--> REVOKED
 *   NOT_GIVEN --decline--> DECLINED
 *   REVOKED --give--> GIVEN   (new explicit action, new timestamp)
 *   DECLINED is terminal for that version; a new version resets to NOT_GIVEN.
 */

export type ConsentAction = "give" | "decline" | "revoke";

const CONSENT_TRANSITIONS: Record<ConsentState, Partial<Record<ConsentAction, ConsentState>>> = {
  NOT_GIVEN: { give: "GIVEN", decline: "DECLINED" },
  GIVEN: { revoke: "REVOKED" },
  DECLINED: {},
  REVOKED: { give: "GIVEN" },
};

export type ConsentTransitionResult = { ok: true; next: ConsentState } | { ok: false; reason: string };

export function nextConsentState(current: ConsentState, action: ConsentAction): ConsentTransitionResult {
  const next = CONSENT_TRANSITIONS[current]?.[action];
  if (!next) {
    return { ok: false, reason: `Cannot ${action} consent from state ${current}.` };
  }
  return { ok: true, next };
}

/**
 * Resolves the state machine's give_consent DERIVED outcome (Section 6, row
 * 11): the case stays ISSUED unless this consent completes both parties'
 * GIVEN state, in which case it becomes RESOLVED_CONSENT. Never invoked
 * directly by decline/revoke — those have fixed `to` states in the table.
 */
export function deriveGiveConsentState(complainantState: ConsentState, respondentState: ConsentState): CaseState {
  return complainantState === "GIVEN" && respondentState === "GIVEN" ? "RESOLVED_CONSENT" : "ISSUED";
}

/** An answer counts only when it is bound to that party's current issued outcome. */
export function consentAnswerCounts(
  record: { state: ConsentState; partyOutcomeId: string | null; partyOutcomeVersion: number | null } | null,
  current: { id: string; version: number } | null,
): ConsentState {
  if (!record || !current) return "NOT_GIVEN";
  if (record.partyOutcomeId !== current.id || record.partyOutcomeVersion !== current.version) return "NOT_GIVEN";
  if (record.state === "GIVEN" || record.state === "DECLINED") return record.state;
  return "NOT_GIVEN";
}

/**
 * After one party's answer is revoked, keep a resolved state only when the
 * answers still bound to the current outcomes justify it.
 */
export function stateAfterOutcomeReissue(
  currentState: CaseState,
  complainant: ConsentState,
  respondent: ConsentState,
): CaseState {
  if (complainant === "DECLINED" || respondent === "DECLINED") return "RESOLVED_DECLINED";
  if (complainant === "GIVEN" && respondent === "GIVEN") return "RESOLVED_CONSENT";
  if (currentState === "RESOLVED_CONSENT" || currentState === "RESOLVED_DECLINED") return "ISSUED";
  return currentState;
}
