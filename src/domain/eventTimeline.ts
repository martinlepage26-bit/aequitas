import type { CaseReadAccess } from "./caseAccess";
import type { EventType, GlobalRole } from "../generated/prisma";

/**
 * Section 10's capability table: "View full event timeline | filtered
 * (consumer) | filtered (retailer handler) | full (case manager)". Section
 * 313: "Case managers see all events; parties see all events except
 * recommendation.drafted (quarantine) and internal note.added flagged
 * private." Section 10 separately names the note-adding capability itself
 * "**private** case note" (case manager only, no party ever has it) — read
 * literally, that makes every NOTE_ADDED event unconditionally private,
 * not conditionally flagged; there is no mutation yet (M3/M4) that could
 * produce a public NOTE_ADDED event to test the alternative reading
 * against. Logged as a judgment call in DECISIONS.md.
 *
 * Only the ASSIGNED case manager gets the full view (H2): another case
 * manager who can see an unclaimed OPEN case to claim it gets the party-level
 * view, like everyone else.
 *
 * ADMIN gets the filtered (party-level) view: Section 10 defines no ADMIN
 * row for this capability, and getAuthorityView already treats ADMIN as
 * having no case-specific authority pending a real staff-access model —
 * defaulting ADMIN to "full" would be the more surprising, less safe guess.
 */
const CASE_MANAGER_ONLY_EVENT_TYPES: EventType[] = ["RECOMMENDATION_DRAFTED", "NOTE_ADDED"];

export function filterEventsForRole<T extends { type: EventType }>(events: T[], viewerRole: GlobalRole, isAssignedManager: boolean): T[] {
  if (viewerRole === "CASE_MANAGER" && isAssignedManager) return events;
  return events.filter((e) => !CASE_MANAGER_ONLY_EVENT_TYPES.includes(e.type));
}

const CONTESTATION_EVENT_TYPES = new Set<EventType>([
  "CONTESTATION_OPENED",
  "CONTESTATION_RESPONDED",
  "CONTESTATION_OVERRULED",
  "CONTESTATION_WITHDRAWN",
]);

function contestationIdFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const id = (payload as { contestationId?: unknown }).contestationId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/**
 * Draft edits stay with staff. An issued outcome is visible to that party
 * and to staff. A missing party id is hidden: the event fails closed.
 */
export function partySeesOutcomeEvent(type: string, payload: unknown, viewerId: string): boolean {
  if (type !== "PARTY_OUTCOME_EDITED" && type !== "PARTY_OUTCOME_ISSUED") return true;
  if (type === "PARTY_OUTCOME_EDITED") return false;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const partyId = (payload as { partyId?: unknown }).partyId;
  return typeof partyId === "string" && partyId.length > 0 && partyId === viewerId;
}

function payloadRecord(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  return payload as Record<string, unknown>;
}

function reissueDetails(payload: unknown): Record<string, unknown> | null {
  const record = payloadRecord(payload);
  if (!record) return null;
  const detailed = record.reason === "outcome_reissued" || typeof record.outcomeId === "string" || typeof record.outcomeVersion === "number";
  return detailed ? record : null;
}

/**
 * A party sees their own re-issue revocation in full. The other party does
 * not see that revocation. When the case actually reopens, the other party
 * sees a case-reopened event with an empty payload. Another party's consent
 * or decline keeps the fact of the answer and omits that party's outcome id and version.
 * The assigned mediator, an approver, and an admin are not passed through here.
 */
export function projectPartyTimelineEvent<T extends { type: string; payload?: unknown }>(event: T, viewerId: string): T | null {
  const details = reissueDetails(event.payload);
  if (event.type === "CONSENT_REVOKED" && details) return details.partyId === viewerId ? event : null;
  if (event.type === "CASE_REOPENED" && details) return details.partyId === viewerId ? event : { ...event, payload: {} };
  if (event.type !== "CONSENT_GIVEN" && event.type !== "CONSENT_DECLINED") return event;
  const record = payloadRecord(event.payload);
  if (!record || record.partyId === viewerId) return event;
  const rest = { ...record };
  delete rest.outcomeId;
  delete rest.outcomeVersion;
  return { ...event, payload: rest };
}

/**
 * Contestation events carry type, actor, and time even when the payload is
 * withheld. A party sees only the contestations they opened. The assigned
 * mediator, an approver, and an admin see every contestation event.
 */
export function visibleCaseEvents<T extends { type: EventType; actorId: string; payload?: unknown }>(
  events: T[],
  viewer: { globalRole: GlobalRole; userId: string; access: CaseReadAccess },
): T[] {
  const roleFiltered = filterEventsForRole(events, viewer.globalRole, viewer.access === "assigned-manager");
  if (viewer.access === "assigned-manager" || viewer.access === "approver" || viewer.access === "admin") return roleFiltered;
  const own = new Set<string>();
  for (const event of events) {
    if (event.type !== "CONTESTATION_OPENED" || event.actorId !== viewer.userId) continue;
    const id = contestationIdFromPayload(event.payload);
    if (id) own.add(id);
  }
  return roleFiltered.flatMap((event) => {
    // A request for a person is visible to the party who made it and to staff.
    if (event.type === "AGENT_ESCALATED" && event.actorId !== viewer.userId) return [];
    // A party's processing choice is private to its author.
    if (event.type === "AGENT_PROCESSING_ACCEPTED" && event.actorId !== viewer.userId) return [];
    const projected = projectPartyTimelineEvent(event, viewer.userId);
    if (!projected || !partySeesOutcomeEvent(projected.type, projected.payload, viewer.userId)) return [];
    if (!CONTESTATION_EVENT_TYPES.has(projected.type)) return [projected];
    const id = contestationIdFromPayload(projected.payload);
    return id !== null && own.has(id) ? [projected] : [];
  });
}
