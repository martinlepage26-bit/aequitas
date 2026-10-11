import type { CaseState, EventType } from "../generated/prisma";

/**
 * Rebuilds a case's state by replaying its event log — Section 8:
 * "A `verify` job can rebuild any case's current state by replaying its
 * events and must match the projection."
 *
 * State changes follow lifecycle events. Consent by one party alone does
 * not resolve a case: the mutation emits CASE_RESOLVED only after both
 * parties consent. Notes, notifications and assignment events are no-ops.
 *
 * CASE_ASSIGNED is a side-effect event (records who claimed the case — see
 * DECISIONS.md) and does not itself drive a state transition; the state
 * change from the same open_intake call is EVIDENCE_INTAKE_OPENED.
 */
export function replayCaseState(events: Array<{ type: EventType; payload?: unknown }>): CaseState | null {
  let state: CaseState | null = null;

  for (const event of events) {
    switch (event.type) {
      case "CASE_CREATED":
        state = "DRAFT";
        break;
      case "CASE_SUBMITTED":
        state = "OPEN";
        break;
      case "EVIDENCE_INTAKE_OPENED":
        state = "EVIDENCE_INTAKE";
        break;
      case "EVIDENCE_SUBMITTED":
      case "EVIDENCE_SUPERSEDED":
        // Section 6 rows 4/5: self-loop on EVIDENCE_INTAKE. Asserted
        // explicitly (not left to the default no-op) so a future state
        // added ahead of these in the machine can't silently mis-replay.
        state = "EVIDENCE_INTAKE";
        break;
      case "EVIDENCE_INTAKE_CLOSED":
        state = "POSITIONS";
        break;
      case "POSITION_SUBMITTED":
        // Section 6 row 7: self-loop on POSITIONS — same reasoning as
        // EVIDENCE_SUBMITTED/EVIDENCE_SUPERSEDED above.
        state = "POSITIONS";
        break;
      case "RECOMMENDATION_DRAFT_REQUESTED":
        state = "DRAFTING";
        break;
      case "RECOMMENDATION_DRAFT_FAILED":
        state = (event.payload as { toState?: string } | null)?.toState === "DRAFTING" ? "DRAFTING" : "POSITIONS";
        break;
      case "RECOMMENDATION_DRAFTED":
        // Section 6 row 9: self-loop on DRAFTING (SYSTEM actor) — same
        // reasoning as the other self-loop rows above.
        state = "DRAFTING";
        break;
      case "RECOMMENDATION_ISSUED":
        state = "ISSUED";
        break;
      case "CASE_RESOLVED":
        state = "RESOLVED_CONSENT";
        break;
      case "CASE_RESOLVED_DECLINED":
        state = "RESOLVED_DECLINED";
        break;
      case "CASE_REOPENED":
        state = "ISSUED";
        break;
      case "CASE_WITHDRAWN":
        state = "WITHDRAWN";
        break;
      case "CASE_CLOSED":
        state = "CLOSED";
        break;
      case "EVIDENCE_ACCESSED":
        // A download audit. It does not move the case.
        break;
      case "SOURCE_RECORDED":
      case "CLAIM_RECORDED":
      case "CLAIM_UPDATED":
      case "CLAIM_EVIDENCE_LINKED":
      case "CLAIM_RELATIONSHIP_RECORDED":
      case "REVIEW_RECORDED":
        // Phase 1 traceable-core writes. They do not move Case.state.
        break;
      case "ASSUMPTION_RECORDED":
      case "ASSUMPTION_ACKNOWLEDGED":
      case "ASSUMPTION_CHALLENGED":
      case "ASSUMPTION_REVISED":
      case "ASSUMPTION_ADDED_MID_CASE":
      case "PIPELINE_RETURNED":
      case "PROPOSAL_RECORDED":
      case "PROPOSAL_ACCEPTED":
      case "PROPOSAL_REJECTED":
      case "CONTEXT_FACTOR_RECORDED":
      case "SYNTHESIS_RECORDED":
      case "SYNTHESIS_REJECTED":
        // Phase 2 pipeline writes. A return is an audit event. It does not move Case.state.
        break;
      case "CONTESTATION_OPENED":
      case "CONTESTATION_RESPONDED":
      case "CONTESTATION_OVERRULED":
      case "CONTESTATION_WITHDRAWN":
      case "RESOLUTION_APPROVED":
        // Phase 3. Contestation and sign-off gate consent; they do not move Case.state.
        break;
      default:
        // Audit-only events do not change the case projection.
        break;
    }
  }

  return state;
}
