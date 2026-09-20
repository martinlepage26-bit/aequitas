import { describe, expect, it } from "vitest";
import type { EventType } from "../../src/generated/prisma";
import { replayCaseState } from "../../src/domain/replay";

const replay = (...types: EventType[]) => replayCaseState(types.map(type => ({ type })));

describe("post-issuance event replay", () => {
  it("requires the resolution event rather than treating one party's consent as agreement", () => {
    expect(replay("RECOMMENDATION_ISSUED", "CONSENT_GIVEN")).toBe("ISSUED");
    expect(replay("RECOMMENDATION_ISSUED", "CONSENT_GIVEN", "CONSENT_GIVEN", "CASE_RESOLVED")).toBe("RESOLVED_CONSENT");
  });
  it("replays a decline and subsequent redraft", () => {
    expect(replay("RECOMMENDATION_ISSUED", "CONSENT_DECLINED", "CASE_RESOLVED_DECLINED")).toBe("RESOLVED_DECLINED");
    expect(replay("CASE_RESOLVED_DECLINED", "RECOMMENDATION_DRAFT_REQUESTED")).toBe("DRAFTING");
  });
  it("reopens a resolved case following revocation", () => {
    expect(replay("CASE_RESOLVED", "CONSENT_REVOKED", "CASE_REOPENED")).toBe("ISSUED");
  });
  it("preserves withdrawal and closure through audit-only events", () => {
    expect(replay("RECOMMENDATION_ISSUED", "CASE_WITHDRAWN", "NOTE_ADDED")).toBe("WITHDRAWN");
    expect(replay("CASE_RESOLVED", "CASE_CLOSED", "NOTE_ADDED")).toBe("CLOSED");
  });
});
