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
 * ADMIN gets the filtered (party-level) view: Section 10 defines no ADMIN
 * row for this capability, and getAuthorityView already treats ADMIN as
 * having no case-specific authority pending a real staff-access model —
 * defaulting ADMIN to "full" would be the more surprising, less safe guess.
 */
const CASE_MANAGER_ONLY_EVENT_TYPES: EventType[] = ["RECOMMENDATION_DRAFTED", "NOTE_ADDED"];

export function filterEventsForRole<T extends { type: EventType }>(events: T[], viewerRole: GlobalRole): T[] {
  if (viewerRole === "CASE_MANAGER") return events;
  return events.filter((e) => !CASE_MANAGER_ONLY_EVENT_TYPES.includes(e.type));
}
