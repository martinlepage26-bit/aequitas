export type CaseAgentTimingEvent = {
  caseId: string;
  type: "EVIDENCE_INTAKE_OPENED" | "RECOMMENDATION_ISSUED";
  createdAt: Date;
};

export type CaseAgentTimingSummary = {
  casesStarted: number;
  casesIssuedWithinWindow: number;
  casesAwaitingIssueAtWindowEnd: number;
  medianElapsedHours: number | null;
  p90ElapsedHours: number | null;
};

export type CaseAgentOutcomeEventType =
  | "AGENT_ENROLLED"
  | "RECOMMENDATION_ISSUED"
  | "AGENT_ESCALATED"
  | "CASE_CLOSED";

export type CaseAgentOutcomeEvent = {
  caseId: string;
  type: CaseAgentOutcomeEventType;
  createdAt: Date;
  seq: number;
  payload: unknown;
};

export type CaseAgentOutcomeSummary = {
  casesEnrolled: number;
  casesWithAgentProposal: number;
  casesHandedToPerson: number;
  casesClosedByAgentWithoutHandoff: number;
  casesClosedByStaffWithoutHandoff: number;
  casesClosedAfterHandoff: number;
  casesStillWithAgentAtWindowEnd: number;
  casesHandedOffOpenAtWindowEnd: number;
  medianHoursToAgentProposal: number | null;
  p90HoursToAgentProposal: number | null;
  medianHoursToAgentClosure: number | null;
  p90HoursToAgentClosure: number | null;
};

function percentileNearestRank(sorted: number[], percentile: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)];
}

function roundedHours(milliseconds: number): number {
  return Math.round((milliseconds / 3_600_000) * 100) / 100;
}

function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function hasOrigin(payload: unknown, origin: string): boolean {
  return payload !== null
    && typeof payload === "object"
    && !Array.isArray(payload)
    && (payload as Record<string, unknown>).origin === origin;
}

function compareEvents(left: CaseAgentOutcomeEvent, right: CaseAgentOutcomeEvent): number {
  return left.createdAt.getTime() - right.createdAt.getTime() || left.seq - right.seq;
}

/**
 * Summarize the pilot's committed intake-to-first-proposal measure. The
 * returned object deliberately contains no case identifiers or party data.
 */
export function summarizeCaseAgentTimings(events: readonly CaseAgentTimingEvent[]): CaseAgentTimingSummary {
  const intakeOpened = new Map<string, number>();
  const issuedAt = new Map<string, number>();

  for (const event of events) {
    const timestamp = event.createdAt.getTime();
    if (!Number.isFinite(timestamp)) continue;
    if (event.type === "EVIDENCE_INTAKE_OPENED") {
      const prior = intakeOpened.get(event.caseId);
      if (prior === undefined || timestamp < prior) intakeOpened.set(event.caseId, timestamp);
    } else {
      const prior = issuedAt.get(event.caseId);
      if (prior === undefined || timestamp < prior) issuedAt.set(event.caseId, timestamp);
    }
  }

  const elapsed = [...intakeOpened].flatMap(([caseId, start]) => {
    const issue = issuedAt.get(caseId);
    return issue !== undefined && issue >= start ? [issue - start] : [];
  }).sort((a, b) => a - b);

  const medianMs = median(elapsed);
  const p90Ms = percentileNearestRank(elapsed, 0.9);

  return {
    casesStarted: intakeOpened.size,
    casesIssuedWithinWindow: elapsed.length,
    casesAwaitingIssueAtWindowEnd: intakeOpened.size - elapsed.length,
    medianElapsedHours: medianMs === null ? null : roundedHours(medianMs),
    p90ElapsedHours: p90Ms === null ? null : roundedHours(p90Ms),
  };
}

/**
 * Summarize agent-enrolled cases as of the report's exclusive end date.
 * The caller supplies only events for the selected non-simulated cohort.
 * The result contains aggregate counts and timings, never case identifiers.
 */
export function summarizeCaseAgentOutcomes(events: readonly CaseAgentOutcomeEvent[]): CaseAgentOutcomeSummary {
  const byCase = new Map<string, CaseAgentOutcomeEvent[]>();
  for (const event of events) {
    if (!event.caseId || !Number.isFinite(event.createdAt.getTime()) || !Number.isFinite(event.seq)) continue;
    const caseEvents = byCase.get(event.caseId) ?? [];
    caseEvents.push(event);
    byCase.set(event.caseId, caseEvents);
  }

  const proposalElapsed: number[] = [];
  const closureElapsed: number[] = [];
  const summary: CaseAgentOutcomeSummary = {
    casesEnrolled: 0,
    casesWithAgentProposal: 0,
    casesHandedToPerson: 0,
    casesClosedByAgentWithoutHandoff: 0,
    casesClosedByStaffWithoutHandoff: 0,
    casesClosedAfterHandoff: 0,
    casesStillWithAgentAtWindowEnd: 0,
    casesHandedOffOpenAtWindowEnd: 0,
    medianHoursToAgentProposal: null,
    p90HoursToAgentProposal: null,
    medianHoursToAgentClosure: null,
    p90HoursToAgentClosure: null,
  };

  for (const caseEvents of byCase.values()) {
    caseEvents.sort(compareEvents);
    const enrolled = caseEvents.find((event) => event.type === "AGENT_ENROLLED");
    if (!enrolled) continue;
    summary.casesEnrolled += 1;

    const enrolledEvents = caseEvents.filter((event) => compareEvents(event, enrolled) >= 0);
    const closure = enrolledEvents.find((event) => event.type === "CASE_CLOSED");
    const firstEscalation = enrolledEvents.find((event) => event.type === "AGENT_ESCALATED"
      && (!closure || compareEvents(event, closure) < 0));
    const proposal = enrolledEvents.find((event) => event.type === "RECOMMENDATION_ISSUED"
      && hasOrigin(event.payload, "case_agent")
      && (!firstEscalation || compareEvents(event, firstEscalation) < 0));
    if (proposal) {
      summary.casesWithAgentProposal += 1;
      proposalElapsed.push(proposal.createdAt.getTime() - enrolled.createdAt.getTime());
    }

    if (firstEscalation) summary.casesHandedToPerson += 1;

    const handedOffBeforeClosure = Boolean(closure && firstEscalation && compareEvents(firstEscalation, closure) < 0);
    if (closure && handedOffBeforeClosure) {
      summary.casesClosedAfterHandoff += 1;
    } else if (closure && hasOrigin(closure.payload, "case_agent")) {
      summary.casesClosedByAgentWithoutHandoff += 1;
      closureElapsed.push(closure.createdAt.getTime() - enrolled.createdAt.getTime());
    } else if (closure) {
      summary.casesClosedByStaffWithoutHandoff += 1;
    } else if (firstEscalation) {
      summary.casesHandedOffOpenAtWindowEnd += 1;
    } else {
      summary.casesStillWithAgentAtWindowEnd += 1;
    }
  }

  proposalElapsed.sort((a, b) => a - b);
  closureElapsed.sort((a, b) => a - b);
  const medianProposal = median(proposalElapsed);
  const medianClosure = median(closureElapsed);
  const p90Proposal = percentileNearestRank(proposalElapsed, 0.9);
  const p90Closure = percentileNearestRank(closureElapsed, 0.9);

  return {
    ...summary,
    medianHoursToAgentProposal: medianProposal === null ? null : roundedHours(medianProposal),
    p90HoursToAgentProposal: p90Proposal === null ? null : roundedHours(p90Proposal),
    medianHoursToAgentClosure: medianClosure === null ? null : roundedHours(medianClosure),
    p90HoursToAgentClosure: p90Closure === null ? null : roundedHours(p90Closure),
  };
}
