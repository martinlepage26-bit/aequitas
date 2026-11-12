import { prisma } from "./prisma";
import type { ScheduledOperationName } from "../domain/scheduledOperations";

type ScheduledProgressWriter = {
  updateMany(args: {
    where: { name: ScheduledOperationName; lastOutcome: "RUNNING" };
    data: { lastHeartbeatAt: Date };
  }): Promise<{ count: number }>;
};

/**
 * Record progress only for the matching scheduled child process. Manual and
 * one-off application calls stay out of the scheduler health record.
 */
export async function recordScheduledOperationProgress(
  operation: ScheduledOperationName,
  env: Readonly<Record<string, string | undefined>> = process.env,
  writer?: ScheduledProgressWriter,
): Promise<boolean> {
  if (env.AEQUITAS_SCHEDULER_OPERATION !== operation) return false;
  try {
    const result = await (writer ?? prisma.scheduledOperationHeartbeat).updateMany({
      where: { name: operation, lastOutcome: "RUNNING" },
      data: { lastHeartbeatAt: new Date() },
    });
    return result.count > 0;
  } catch {
    // Progress writes must not interrupt case or notification processing.
    console.error("Scheduled operation progress write failed.");
    return false;
  }
}
