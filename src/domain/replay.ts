import type { CaseState, EventType } from "../generated/prisma";

/**
 * Rebuilds a case's state by replaying its event log — Section 8:
 * "A `verify` job can rebuild any case's current state by replaying its
 * events and must match the projection."
 *
 * create_case, submit_case, open_intake, submit_evidence,
 * supersede_evidence, close_intake, submit_position, request_draft,
 * draft_completed, and issue_recommendation are the mutations built so far
 * (src/domain/mutate.ts) — consent is M4 work per Section 19. Event types
 * without a mutation yet are intentionally
 * no-ops here rather than guessed at, and each milestone that wires a new
 * mutation must add its transition to this reducer or verify:events will
 * silently under-check it.
 *
 * CASE_ASSIGNED is a side-effect event (records who claimed the case — see
 * DECISIONS.md) and does not itself drive a state transition; the state
 * change from the same open_intake call is EVIDENCE_INTAKE_OPENED.
 */
export function replayCaseState(events: Array<{ type: EventType }>): CaseState | null {
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
      case "RECOMMENDATION_DRAFTED":
        // Section 6 row 9: self-loop on DRAFTING (SYSTEM actor) — same
        // reasoning as the other self-loop rows above.
        state = "DRAFTING";
        break;
      case "RECOMMENDATION_ISSUED":
        state = "ISSUED";
        break;
      default:
        // Not yet implemented as a mutation — see module comment.
        break;
    }
  }

  return state;
}
