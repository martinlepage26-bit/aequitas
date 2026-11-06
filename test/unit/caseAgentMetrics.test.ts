import { describe, expect, it } from "vitest";
import { summarizeCaseAgentTimings, type CaseAgentTimingEvent } from "../../src/domain/caseAgent/metrics";

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
      casesIssuedWithinWindow: 2,
      casesAwaitingIssueAtWindowEnd: 1,
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
      casesIssuedWithinWindow: 0,
      casesAwaitingIssueAtWindowEnd: 1,
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
      casesIssuedWithinWindow: 0,
      casesAwaitingIssueAtWindowEnd: 1,
    });
  });
});
