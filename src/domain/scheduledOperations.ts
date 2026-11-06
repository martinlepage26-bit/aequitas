export const SCHEDULED_OPERATIONS = [
  { name: "notification_retry", entrypoint: "scripts/deliver-notifications.ts", intervalMs: 15 * 60 * 1000 },
  { name: "case_agent", entrypoint: "scripts/run-case-agent.ts", intervalMs: 10 * 60 * 1000 },
] as const;

export type ScheduledOperationName = (typeof SCHEDULED_OPERATIONS)[number]["name"];

export type ScheduledOperationHealth = "never_run" | "running" | "stalled" | "healthy" | "overdue" | "failed" | "interrupted" | "unknown";
export const SCHEDULER_HEARTBEAT_INTERVAL_MS = 60_000;
export const SCHEDULER_HEARTBEAT_STALE_AFTER_MS = 3 * SCHEDULER_HEARTBEAT_INTERVAL_MS;

export type ScheduledOperationHeartbeatSnapshot = {
  lastStartedAt: Date | null;
  lastHeartbeatAt: Date | null;
  lastFinishedAt: Date | null;
  lastOutcome: string | null;
};

/**
 * Classify only aggregate worker state. Active jobs are monitored by periodic
 * pulses; completed jobs are checked against their configured schedule.
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
    case "RUNNING": return activityAgeMs > SCHEDULER_HEARTBEAT_STALE_AFTER_MS ? "stalled" : "running";
    case "SUCCEEDED": return scheduleAgeMs > intervalMs * 2 ? "overdue" : "healthy";
    case "FAILED": return "failed";
    case "INTERRUPTED": return "interrupted";
    default: return "unknown";
  }
}

export function scheduledOperationsPlan() {
  return SCHEDULED_OPERATIONS.map(({ name, entrypoint, intervalMs }) => ({
    name,
    entrypoint,
    intervalMinutes: intervalMs / 60_000,
  }));
}
