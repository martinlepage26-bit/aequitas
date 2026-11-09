export const SCHEDULED_OPERATIONS = [
  { name: "notification_retry", entrypoint: "scripts/deliver-notifications.ts", intervalMs: 15 * 60 * 1000 },
  { name: "case_agent", entrypoint: "scripts/run-case-agent.ts", intervalMs: 10 * 60 * 1000 },
] as const;

export type ScheduledOperationName = (typeof SCHEDULED_OPERATIONS)[number]["name"];

export type ScheduledOperationHealth = "never_run" | "running" | "stalled" | "healthy" | "overdue" | "failed" | "interrupted" | "unknown";
export const SCHEDULER_PROGRESS_STALE_AFTER_MS = 3 * 60_000;

/** A running operation has reported recent completed work; a completed one is within its schedule. */
export function scheduledOperationIsHealthy(health: ScheduledOperationHealth): boolean {
  return health === "running" || health === "healthy";
}

export type ScheduledOperationHeartbeatSnapshot = {
  lastStartedAt: Date | null;
  lastHeartbeatAt: Date | null;
  lastFinishedAt: Date | null;
  lastOutcome: string | null;
};

export type ScheduledOperationReleaseHeartbeatSnapshot = ScheduledOperationHeartbeatSnapshot & {
  lastSuccessfulAt: Date | null;
};

/** Return active child runs whose own progress has gone stale beyond recovery. */
export function scheduledOperationsWithStalledChildren(
  operations: readonly { name: ScheduledOperationName; intervalMs: number }[],
  heartbeats: ReadonlyMap<ScheduledOperationName, ScheduledOperationHeartbeatSnapshot>,
  childStartedAt: ReadonlyMap<ScheduledOperationName, Date>,
  now = new Date(),
): ScheduledOperationName[] {
  return operations.flatMap((operation) => {
    const startedAt = childStartedAt.get(operation.name);
    if (!startedAt) return [];

    const heartbeat = heartbeats.get(operation.name) ?? null;
    const belongsToCurrentRun = Boolean(
      heartbeat
      && heartbeat.lastOutcome === "RUNNING"
      && heartbeat.lastStartedAt
      && heartbeat.lastStartedAt.getTime() >= startedAt.getTime(),
    );
    const stalled = heartbeat && belongsToCurrentRun
      ? scheduledOperationHealth(operation.intervalMs, heartbeat, now) === "stalled"
      : now.getTime() - startedAt.getTime() > SCHEDULER_PROGRESS_STALE_AFTER_MS;
    return stalled ? [operation.name] : [];
  });
}

/**
 * Classify only aggregate worker state. Active jobs are monitored by progress
 * pulses from their child process; completed jobs are checked against schedule.
 */
export function scheduledOperationHealth(
  intervalMs: number,
  heartbeat: ScheduledOperationHeartbeatSnapshot | null,
  now = new Date(),
): ScheduledOperationHealth {
  if (!heartbeat?.lastStartedAt) return "never_run";
  const activityAt = heartbeat.lastHeartbeatAt ?? heartbeat.lastStartedAt;
  const activityAgeMs = Math.max(0, now.getTime() - activityAt.getTime());
  const finishedAt = heartbeat.lastFinishedAt ?? heartbeat.lastStartedAt;
  const scheduleAgeMs = Math.max(0, now.getTime() - finishedAt.getTime());
  switch (heartbeat.lastOutcome) {
    case "RUNNING": return activityAgeMs > SCHEDULER_PROGRESS_STALE_AFTER_MS ? "stalled" : "running";
    case "SUCCEEDED": return scheduleAgeMs > intervalMs * 2 ? "overdue" : "healthy";
    case "FAILED": return "failed";
    case "INTERRUPTED": return "interrupted";
    default: return "unknown";
  }
}

/** Require one successful run of every worker after the new release started. */
export function scheduledOperationsMissingReleaseSuccess(
  operations: readonly { name: string; intervalMs: number }[],
  heartbeats: ReadonlyMap<string, ScheduledOperationReleaseHeartbeatSnapshot>,
  releaseStartedAt: Date,
  now = new Date(),
): string[] {
  return operations.flatMap((operation) => {
    const heartbeat = heartbeats.get(operation.name);
    const successfulSinceRelease = Boolean(
      heartbeat?.lastStartedAt
      && heartbeat.lastStartedAt.getTime() >= releaseStartedAt.getTime()
      && heartbeat.lastSuccessfulAt
      && heartbeat.lastSuccessfulAt.getTime() >= releaseStartedAt.getTime()
      && heartbeat.lastOutcome === "SUCCEEDED"
      && scheduledOperationHealth(operation.intervalMs, heartbeat, now) === "healthy",
    );
    return successfulSinceRelease ? [] : [operation.name];
  });
}

export function scheduledOperationsPlan() {
  return SCHEDULED_OPERATIONS.map(({ name, entrypoint, intervalMs }) => ({
    name,
    entrypoint,
    intervalMinutes: intervalMs / 60_000,
  }));
}
