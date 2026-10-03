import { describe, expect, it } from "vitest";
import type { EventType, GlobalRole } from "../../src/generated/prisma";
import { filterEventsForRole } from "../../src/domain/eventTimeline";

const ALL_TYPES: EventType[] = [
  "CASE_CREATED",
  "CASE_SUBMITTED",
  "CASE_ASSIGNED",
  "COI_DECLARED",
  "EVIDENCE_INTAKE_OPENED",
  "EVIDENCE_SUBMITTED",
  "EVIDENCE_SUPERSEDED",
  "EVIDENCE_INTAKE_CLOSED",
  "POSITION_SUBMITTED",
  "CHRONOLOGY_ENTRY_SUBMITTED",
  "RECOMMENDATION_DRAFT_REQUESTED",
  "RECOMMENDATION_DRAFTED",
  "RECOMMENDATION_ISSUED",
  "RECOMMENDATION_SUPERSEDED",
  "CONSENT_GIVEN",
  "CONSENT_DECLINED",
  "CONSENT_REVOKED",
  "CASE_RESOLVED",
  "CASE_RESOLVED_DECLINED",
  "CASE_REOPENED",
  "CASE_WITHDRAWN",
  "CASE_CLOSED",
  "EXPORT_GENERATED",
  "DEADLINE_EXPIRED",
  "PARTY_NOTIFIED",
  "NOTE_ADDED",
  "ACCESS_STAFF_GRANTED",
];

const events = ALL_TYPES.map((type, i) => ({ type, seq: i + 1 }));

describe("filterEventsForRole — Section 313 timeline visibility", () => {
  it("the assigned CASE_MANAGER sees every event type, unfiltered", () => {
    const result = filterEventsForRole(events, "CASE_MANAGER", true);
    expect(result).toHaveLength(ALL_TYPES.length);
    expect(result.map((e) => e.type)).toEqual(ALL_TYPES);
  });

  const partyRoles: GlobalRole[] = ["COMPLAINANT", "RESPONDENT", "ADMIN"];
  for (const role of partyRoles) {
    it(`${role} never sees RECOMMENDATION_DRAFTED or NOTE_ADDED`, () => {
      const result = filterEventsForRole(events, role, false);
      expect(result.map((e) => e.type)).not.toContain("RECOMMENDATION_DRAFTED");
      expect(result.map((e) => e.type)).not.toContain("NOTE_ADDED");
    });

    it(`${role} sees every other event type unfiltered`, () => {
      const result = filterEventsForRole(events, role, false);
      const expected = ALL_TYPES.filter((t) => t !== "RECOMMENDATION_DRAFTED" && t !== "NOTE_ADDED");
      expect(result.map((e) => e.type)).toEqual(expected);
    });
  }

  it("consumer and retailer handler see identical filtering (Section 10: both listed as 'filtered', not differentiated)", () => {
    const consumerView = filterEventsForRole(events, "COMPLAINANT", false).map((e) => e.type);
    const retailerView = filterEventsForRole(events, "RESPONDENT", false).map((e) => e.type);
    expect(consumerView).toEqual(retailerView);
  });

  it("is a pure function: does not mutate the input array", () => {
    const before = [...events];
    filterEventsForRole(events, "COMPLAINANT", false);
    expect(events).toEqual(before);
  });
});
