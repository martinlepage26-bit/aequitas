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
