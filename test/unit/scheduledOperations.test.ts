import { describe, expect, it } from "vitest";
import { scheduledOperationsPlan } from "../../src/domain/scheduledOperations";

describe("scheduled operations", () => {
  it("retries notifications every 15 minutes and runs the case agent every 10", () => {
    expect(scheduledOperationsPlan()).toEqual([
      { name: "notification_retry", entrypoint: "scripts/deliver-notifications.ts", intervalMinutes: 15 },
      { name: "case_agent", entrypoint: "scripts/run-case-agent.ts", intervalMinutes: 10 },
    ]);
  });
});
