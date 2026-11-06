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

function percentileNearestRank(sorted: number[], percentile: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)];
}

function roundedHours(milliseconds: number): number {
  return Math.round((milliseconds / 3_600_000) * 100) / 100;
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

  const middle = Math.floor(elapsed.length / 2);
  const medianMs = elapsed.length === 0
    ? null
    : elapsed.length % 2 === 1
      ? elapsed[middle]
      : (elapsed[middle - 1] + elapsed[middle]) / 2;
  const p90Ms = percentileNearestRank(elapsed, 0.9);

  return {
    casesStarted: intakeOpened.size,
    casesIssuedWithinWindow: elapsed.length,
    casesAwaitingIssueAtWindowEnd: intakeOpened.size - elapsed.length,
    medianElapsedHours: medianMs === null ? null : roundedHours(medianMs),
    p90ElapsedHours: p90Ms === null ? null : roundedHours(p90Ms),
  };
}
