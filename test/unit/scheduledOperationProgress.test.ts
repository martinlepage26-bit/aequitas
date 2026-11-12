import { describe, expect, it, vi } from "vitest";
import { recordScheduledOperationProgress } from "../../src/lib/scheduledOperationProgress";

describe("scheduled operation progress", () => {
  it("does not write for manual calls or a different scheduled operation", async () => {
    const writer = { updateMany: vi.fn().mockResolvedValue({ count: 1 }) };

    expect(await recordScheduledOperationProgress("case_agent", {}, writer)).toBe(false);
    expect(await recordScheduledOperationProgress("case_agent", { AEQUITAS_SCHEDULER_OPERATION: "notification_retry" }, writer)).toBe(false);
    expect(writer.updateMany).not.toHaveBeenCalled();
  });

  it("refreshes only the matching running operation after child work completes", async () => {
    const writer = { updateMany: vi.fn().mockResolvedValue({ count: 1 }) };

    expect(await recordScheduledOperationProgress(
      "case_agent",
      { AEQUITAS_SCHEDULER_OPERATION: "case_agent" },
      writer,
    )).toBe(true);
    expect(writer.updateMany).toHaveBeenCalledWith({
      where: { name: "case_agent", lastOutcome: "RUNNING" },
      data: { lastHeartbeatAt: expect.any(Date) },
    });
  });

  it("ignores a completion after the supervisor has stopped marking the operation running", async () => {
    const writer = { updateMany: vi.fn().mockResolvedValue({ count: 0 }) };

    expect(await recordScheduledOperationProgress(
      "notification_retry",
      { AEQUITAS_SCHEDULER_OPERATION: "notification_retry" },
      writer,
    )).toBe(false);
  });

  it("does not interrupt scheduled work when the monitoring write fails", async () => {
    const writer = { updateMany: vi.fn().mockRejectedValue(new Error("database unavailable")) };
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(await recordScheduledOperationProgress(
      "case_agent",
      { AEQUITAS_SCHEDULER_OPERATION: "case_agent" },
      writer,
    )).toBe(false);
    expect(error).toHaveBeenCalledWith("Scheduled operation progress write failed.");
  });
});
