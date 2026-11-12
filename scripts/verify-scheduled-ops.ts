import "../src/lib/loadEnv";
import { setTimeout as delay } from "node:timers/promises";
import { prisma } from "../src/lib/prisma";
import { scheduledOperationsMissingReleaseSuccess, SCHEDULED_OPERATIONS } from "../src/domain/scheduledOperations";

const POLL_INTERVAL_MS = 2_000;
const READY_TIMEOUT_MS = 180_000;

async function main() {
  const releaseStartedAt = new Date(process.env.SCHEDULER_READY_SINCE ?? "");
  if (!Number.isFinite(releaseStartedAt.getTime())) {
    throw new Error("A valid SCHEDULER_READY_SINCE timestamp is required.");
  }

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (true) {
    const now = new Date();
    const rows = await prisma.scheduledOperationHeartbeat.findMany({
      where: { name: { in: SCHEDULED_OPERATIONS.map((operation) => operation.name) } },
    });
    const heartbeats = new Map(rows.map((row) => [row.name, {
      lastStartedAt: row.lastStartedAt,
      lastHeartbeatAt: row.lastHeartbeatAt,
      lastFinishedAt: row.lastFinishedAt,
      lastSuccessfulAt: row.lastSuccessfulAt,
      lastOutcome: row.lastOutcome,
    }]));
    const missing = scheduledOperationsMissingReleaseSuccess(SCHEDULED_OPERATIONS, heartbeats, releaseStartedAt, now);

    if (missing.length === 0) {
      console.log("All scheduled operations completed successfully on this release.");
      return;
    }

    const failed = SCHEDULED_OPERATIONS.flatMap((operation) => {
      const heartbeat = heartbeats.get(operation.name);
      return heartbeat?.lastStartedAt
        && heartbeat.lastStartedAt.getTime() >= releaseStartedAt.getTime()
        && heartbeat.lastOutcome === "FAILED"
        ? [operation.name]
        : [];
    });
    if (failed.length > 0) {
      throw new Error(`Scheduled operations failed on this release: ${failed.join(", ")}.`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`Scheduled operations did not complete successfully on this release: ${missing.join(", ")}.`);
    }
    await delay(POLL_INTERVAL_MS);
  }
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Scheduled operation readiness could not be verified.");
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
