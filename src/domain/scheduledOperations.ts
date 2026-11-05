export const SCHEDULED_OPERATIONS = [
  { name: "notification_retry", entrypoint: "scripts/deliver-notifications.ts", intervalMs: 15 * 60 * 1000 },
  { name: "case_agent", entrypoint: "scripts/run-case-agent.ts", intervalMs: 10 * 60 * 1000 },
] as const;

export function scheduledOperationsPlan() {
  return SCHEDULED_OPERATIONS.map(({ name, entrypoint, intervalMs }) => ({
    name,
    entrypoint,
    intervalMinutes: intervalMs / 60_000,
  }));
}
