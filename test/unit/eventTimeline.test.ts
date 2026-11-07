import { describe, expect, it } from "vitest";
import type { EventType, GlobalRole } from "../../src/generated/prisma";
import { filterEventsForRole, visibleCaseEvents } from "../../src/domain/eventTimeline";

const ALL_TYPES: EventType[] = [
  "CASE_CREATED",
  "CASE_SUBMITTED",
  "CASE_ASSIGNED",
  "COI_DECLARED",
  "EVIDENCE_INTAKE_OPENED",
  "EVIDENCE_SUBMITTED",
  "EVIDENCE_ACCESSED",
  "EVIDENCE_SUPERSEDED",
  "EVIDENCE_INTAKE_CLOSED",
  "PARTY_INTAKE_READY_MARKED",
  "PARTY_INTAKE_READY_CLEARED",
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

describe("visibleCaseEvents contestation privacy", () => {
  const openedAt = "2026-10-20T03:00:00.000Z";
  const answeredAt = "2026-10-20T03:05:00.000Z";
  const timeline = [
    { type: "CASE_CREATED" as const, actorId: "system", payload: {}, createdAt: "2026-10-20T01:00:00.000Z" },
    { type: "CONTESTATION_OPENED" as const, actorId: "complainant", payload: { contestationId: "c-own", grounds: "SECRET-GROUNDS" }, createdAt: openedAt },
    { type: "CONTESTATION_RESPONDED" as const, actorId: "manager", payload: { contestationId: "c-own", response: "SECRET-RESPONSE" }, createdAt: answeredAt },
    { type: "CONTESTATION_OPENED" as const, actorId: "respondent", payload: { contestationId: "c-other" }, createdAt: "2026-10-20T04:00:00.000Z" },
  ];

  it("omits the other party's contestation type, actor, and time from a party", () => {
    const visible = visibleCaseEvents(timeline, { globalRole: "COMPLAINANT", userId: "complainant", access: "party" });
    const serialized = JSON.stringify(visible);
    expect(visible.map((event) => event.type)).toEqual(["CASE_CREATED", "CONTESTATION_OPENED", "CONTESTATION_RESPONDED"]);
    expect(serialized).toContain("SECRET-GROUNDS");
    expect(serialized).toContain(openedAt);
    expect(serialized).toContain("manager");
    expect(serialized).not.toContain("c-other");
    expect(serialized).not.toContain("2026-10-20T04:00:00.000Z");
    expect(serialized).not.toContain("respondent");
  });

  it("shows every contestation event to the mediator, an approver, and an admin", () => {
    const withNote = [...timeline, { type: "NOTE_ADDED" as const, actorId: "manager", payload: { reason: "PRIVATE-NOTE" }, createdAt: "2026-10-20T05:00:00.000Z" }];
    for (const viewer of [
      { globalRole: "CASE_MANAGER" as const, userId: "manager", access: "assigned-manager" as const },
      { globalRole: "CASE_MANAGER" as const, userId: "approver", access: "approver" as const },
      { globalRole: "ADMIN" as const, userId: "admin", access: "admin" as const },
    ]) {
      const visible = visibleCaseEvents(withNote, viewer);
      expect(visible.map((event) => event.type).filter((type) => type.startsWith("CONTESTATION_"))).toHaveLength(3);
      if (viewer.access !== "assigned-manager") expect(visible.map((event) => event.type)).not.toContain("NOTE_ADDED");
    }
    const claimable = visibleCaseEvents(timeline, { globalRole: "CASE_MANAGER", userId: "other", access: "claimable" });
    expect(claimable.map((event) => event.type)).toEqual(["CASE_CREATED"]);
  });
});

describe("visibleCaseEvents party outcome privacy", () => {
  const timeline = [
    { type: "PARTY_OUTCOME_EDITED" as const, actorId: "manager", payload: { partyId: "complainant", outcomeId: "o1", version: 1, body: "DRAFT-LEAK" } },
    { type: "PARTY_OUTCOME_ISSUED" as const, actorId: "manager", payload: { partyId: "complainant", outcomeId: "o1", version: 1 } },
    { type: "PARTY_OUTCOME_ISSUED" as const, actorId: "manager", payload: { partyId: "respondent", outcomeId: "o2", version: 1 } },
    { type: "PARTY_OUTCOME_ISSUED" as const, actorId: "manager", payload: {} },
  ];

  it("shows a party only their own issued outcome event", () => {
    const visible = visibleCaseEvents(timeline, { globalRole: "COMPLAINANT", userId: "complainant", access: "party" });
    expect(visible).toHaveLength(1);
    expect(visible[0]?.type).toBe("PARTY_OUTCOME_ISSUED");
    expect(JSON.stringify(visible)).not.toContain("respondent");
    expect(JSON.stringify(visible)).not.toContain("DRAFT-LEAK");
    expect(JSON.stringify(visible)).not.toContain("o2");
  });

  it("shows the other party a neutral reopened case, and shows the revocation to staff", () => {
    const timeline = [
      { type: "CONSENT_GIVEN" as const, actorId: "complainant", payload: { partyId: "complainant", outcomeId: "old-outcome", outcomeVersion: 1 } },
      { type: "CONSENT_REVOKED" as const, actorId: "manager", payload: { partyId: "complainant", outcomeId: "old-outcome", outcomeVersion: 1, reason: "outcome_reissued" } },
      { type: "CASE_REOPENED" as const, actorId: "manager", payload: { partyId: "complainant", reason: "outcome_reissued" } },
      { type: "CONSENT_REVOKED" as const, actorId: "respondent", payload: { recommendationId: "rec", partyId: "respondent" } },
      { type: "CASE_REOPENED" as const, actorId: "respondent", payload: {} },
    ];
    const respondent = visibleCaseEvents(timeline, { globalRole: "RESPONDENT", userId: "respondent", access: "party" });
    expect(respondent.map((event) => event.type)).toEqual(["CONSENT_GIVEN", "CASE_REOPENED", "CONSENT_REVOKED", "CASE_REOPENED"]);
    expect(respondent[0]?.payload).toEqual({ partyId: "complainant" });
    expect(respondent[1]?.payload).toEqual({});
    expect(JSON.stringify(respondent)).not.toContain("old-outcome");
    expect(JSON.stringify(respondent)).not.toContain("outcome_reissued");
    expect(JSON.stringify(respondent)).not.toContain("outcomeVersion");
    const complainant = visibleCaseEvents(timeline, { globalRole: "COMPLAINANT", userId: "complainant", access: "party" });
    expect(complainant).toHaveLength(timeline.length);
    expect(JSON.stringify(complainant)).toContain("old-outcome");
    for (const viewer of [
      { globalRole: "CASE_MANAGER" as const, userId: "manager", access: "assigned-manager" as const },
      { globalRole: "CASE_MANAGER" as const, userId: "approver", access: "approver" as const },
      { globalRole: "ADMIN" as const, userId: "admin", access: "admin" as const },
    ]) {
      const visible = visibleCaseEvents(timeline, viewer);
      expect(visible).toHaveLength(timeline.length);
      expect(JSON.stringify(visible)).toContain("outcome_reissued");
      expect(JSON.stringify(visible)).toContain("old-outcome");
    }
  });

  it("omits the other party's outcome id and version from a decline", () => {
    const timeline = [
      { type: "CONSENT_DECLINED" as const, actorId: "complainant", payload: { partyId: "complainant", outcomeId: "declined-outcome", outcomeVersion: 2 } },
    ];
    const respondent = visibleCaseEvents(timeline, { globalRole: "RESPONDENT", userId: "respondent", access: "party" });
    expect(respondent).toHaveLength(1);
    expect(respondent[0]?.payload).toEqual({ partyId: "complainant" });
    expect(JSON.stringify(visibleCaseEvents(timeline, { globalRole: "COMPLAINANT", userId: "complainant", access: "party" }))).toContain("declined-outcome");
    expect(JSON.stringify(visibleCaseEvents(timeline, { globalRole: "CASE_MANAGER", userId: "manager", access: "assigned-manager" }))).toContain("declined-outcome");
    expect(JSON.stringify(visibleCaseEvents(timeline, { globalRole: "ADMIN", userId: "admin", access: "admin" }))).toContain("outcomeVersion");
  });

  it("shows drafts and both parties' outcomes to the mediator, an approver, and an admin", () => {
    for (const viewer of [
      { globalRole: "CASE_MANAGER" as const, userId: "manager", access: "assigned-manager" as const },
      { globalRole: "CASE_MANAGER" as const, userId: "approver", access: "approver" as const },
      { globalRole: "ADMIN" as const, userId: "admin", access: "admin" as const },
    ]) {
      expect(visibleCaseEvents(timeline, viewer)).toHaveLength(timeline.length);
    }
  });
});
