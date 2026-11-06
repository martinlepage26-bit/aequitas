import { describe, expect, it } from "vitest";
import { scheduledOperationHealth, scheduledOperationsPlan } from "../../src/domain/scheduledOperations";

describe("scheduled operations", () => {
  it("retries notifications every 15 minutes and runs the case agent every 10", () => {
    expect(scheduledOperationsPlan()).toEqual([
      { name: "notification_retry", entrypoint: "scripts/deliver-notifications.ts", intervalMinutes: 15 },
      { name: "case_agent", entrypoint: "scripts/run-case-agent.ts", intervalMinutes: 10 },
    ]);
  });

  it("reports missing, healthy, overdue, running, stalled, failed, and interrupted workers", () => {
    const now = new Date("2026-11-06T12:00:00.000Z");
    const intervalMs = 10 * 60 * 1000;
    expect(scheduledOperationHealth(intervalMs, null, now)).toBe("never_run");
    const recent = { lastStartedAt: new Date(now.getTime() - 60_000), lastHeartbeatAt: new Date(now.getTime() - 60_000), lastFinishedAt: new Date(now.getTime() - 60_000) };
    expect(scheduledOperationHealth(intervalMs, { ...recent, lastOutcome: "SUCCEEDED" }, now)).toBe("healthy");
    expect(scheduledOperationHealth(intervalMs, { ...recent, lastStartedAt: new Date(now.getTime() - 40 * 60_000), lastFinishedAt: new Date(now.getTime() - 19 * 60_000), lastOutcome: "SUCCEEDED" }, now)).toBe("healthy");
    expect(scheduledOperationHealth(intervalMs, { ...recent, lastStartedAt: new Date(now.getTime() - 31 * 60_000), lastFinishedAt: new Date(now.getTime() - 21 * 60_000), lastOutcome: "SUCCEEDED" }, now)).toBe("overdue");
    expect(scheduledOperationHealth(intervalMs, { ...recent, lastOutcome: "RUNNING" }, now)).toBe("running");
    expect(scheduledOperationHealth(intervalMs, { ...recent, lastStartedAt: new Date(now.getTime() - 40 * 60_000), lastOutcome: "RUNNING" }, now)).toBe("running");
    expect(scheduledOperationHealth(intervalMs, { ...recent, lastStartedAt: new Date(now.getTime() - 10 * 60_000), lastHeartbeatAt: new Date(now.getTime() - 4 * 60_000), lastOutcome: "RUNNING" }, now)).toBe("stalled");
    expect(scheduledOperationHealth(intervalMs, { ...recent, lastOutcome: "FAILED" }, now)).toBe("failed");
    expect(scheduledOperationHealth(intervalMs, { ...recent, lastOutcome: "INTERRUPTED" }, now)).toBe("interrupted");
    expect(scheduledOperationHealth(intervalMs, { ...recent, lastOutcome: "UNKNOWN" }, now)).toBe("unknown");
  });
});
