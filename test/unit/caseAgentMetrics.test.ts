import { describe, expect, it } from "vitest";
import {
  summarizeCaseAgentOutcomes,
  summarizeCaseAgentTimings,
  type CaseAgentOutcomeEvent,
  type CaseAgentTimingEvent,
} from "../../src/domain/caseAgent/metrics";

const at = (hours: number) => new Date(Date.UTC(2026, 10, 1) + hours * 3_600_000);

describe("case-agent pilot timing metrics", () => {
  it("reports aggregate first-issue timing and counts cases still waiting", () => {
    const events: CaseAgentTimingEvent[] = [
      { caseId: "case-a", type: "EVIDENCE_INTAKE_OPENED", createdAt: at(0) },
      { caseId: "case-a", type: "RECOMMENDATION_ISSUED", createdAt: at(24) },
      { caseId: "case-a", type: "RECOMMENDATION_ISSUED", createdAt: at(48) },
      { caseId: "case-b", type: "EVIDENCE_INTAKE_OPENED", createdAt: at(0) },
      { caseId: "case-c", type: "RECOMMENDATION_ISSUED", createdAt: at(8) },
      { caseId: "case-d", type: "EVIDENCE_INTAKE_OPENED", createdAt: at(0) },
      { caseId: "case-d", type: "RECOMMENDATION_ISSUED", createdAt: at(72) },
    ];

    expect(summarizeCaseAgentTimings(events)).toEqual({
      casesStarted: 3,
      casesIssuedByWindowEnd: 2,
      casesWithoutIssueByWindowEnd: 1,
      medianElapsedHours: 48,
      p90ElapsedHours: 72,
    });
  });

  it("returns null timings when there is no issued case and ignores malformed dates", () => {
    expect(summarizeCaseAgentTimings([
      { caseId: "waiting", type: "EVIDENCE_INTAKE_OPENED", createdAt: at(0) },
      { caseId: "bad-date", type: "EVIDENCE_INTAKE_OPENED", createdAt: new Date(Number.NaN) },
    ])).toEqual({
      casesStarted: 1,
      casesIssuedByWindowEnd: 0,
      casesWithoutIssueByWindowEnd: 1,
      medianElapsedHours: null,
      p90ElapsedHours: null,
    });
  });

  it("does not treat an issue before intake as a completed timing", () => {
    expect(summarizeCaseAgentTimings([
      { caseId: "out-of-order", type: "RECOMMENDATION_ISSUED", createdAt: at(1) },
      { caseId: "out-of-order", type: "EVIDENCE_INTAKE_OPENED", createdAt: at(2) },
    ])).toMatchObject({
      casesStarted: 1,
      casesIssuedByWindowEnd: 0,
      casesWithoutIssueByWindowEnd: 1,
    });
  });
});

describe("case-agent aggregate outcome metrics", () => {
  it("separates agent completion, handoffs, staff closures and open work", () => {
    const event = (
      caseId: string,
      type: CaseAgentOutcomeEvent["type"],
      hours: number,
      seq: number,
      origin?: string,
    ): CaseAgentOutcomeEvent => ({
      caseId,
      type,
      createdAt: at(hours),
      seq,
      payload: origin ? { origin } : {},
    });
    const events = [
      event("handed-off-closed", "AGENT_ENROLLED", 0, 1),
      event("handed-off-closed", "RECOMMENDATION_ISSUED", 2, 2, "case_agent"),
      event("handed-off-closed", "AGENT_ESCALATED", 4, 3),
      event("handed-off-closed", "CASE_CLOSED", 7, 4),
      event("agent-closed", "AGENT_ENROLLED", 0, 1),
      event("agent-closed", "RECOMMENDATION_ISSUED", 3, 2, "case_agent"),
      event("agent-closed", "CASE_CLOSED", 30, 3, "case_agent"),
      event("active", "AGENT_ENROLLED", 0, 1),
      event("handed-off-open", "AGENT_ENROLLED", 0, 1),
      event("handed-off-open", "AGENT_ESCALATED", 1, 2),
      event("staff-closed", "AGENT_ENROLLED", 0, 1),
      event("staff-closed", "CASE_CLOSED", 8, 2),
    ];

    expect(summarizeCaseAgentOutcomes(events)).toEqual({
      casesEnrolled: 5,
      casesWithAgentProposal: 2,
      casesHandedToPerson: 2,
      casesClosedByAgentWithoutHandoff: 1,
      casesClosedByStaffWithoutHandoff: 1,
      casesClosedAfterHandoff: 1,
      casesStillWithAgentAtWindowEnd: 1,
      casesHandedOffOpenAtWindowEnd: 1,
      medianHoursToAgentProposal: 2.5,
      p90HoursToAgentProposal: 3,
      medianHoursToAgentClosure: 30,
      p90HoursToAgentClosure: 30,
    });
  });

  it("requires agent-origin events after enrollment and returns no case identifiers", () => {
    const event = (
      type: CaseAgentOutcomeEvent["type"],
      hours: number,
      seq: number,
      origin?: string,
    ): CaseAgentOutcomeEvent => ({
      caseId: "private-case-id",
      type,
      createdAt: at(hours),
      seq,
      payload: origin ? { origin } : {},
    });

    const result = summarizeCaseAgentOutcomes([
      event("RECOMMENDATION_ISSUED", 1, 1, "case_agent"),
      event("AGENT_ENROLLED", 2, 2),
      event("RECOMMENDATION_ISSUED", 3, 3, "case_manager"),
      event("CASE_CLOSED", 4, 4, "case_agent"),
      event("AGENT_ENROLLED", Number.NaN, 5),
    ]);

    expect(result).toMatchObject({
      casesEnrolled: 1,
      casesWithAgentProposal: 0,
      casesClosedByAgentWithoutHandoff: 1,
      medianHoursToAgentProposal: null,
      medianHoursToAgentClosure: 2,
    });
    expect(JSON.stringify(result)).not.toContain("private-case-id");
  });
});
