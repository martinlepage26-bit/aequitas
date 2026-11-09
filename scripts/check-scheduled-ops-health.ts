import "../src/lib/loadEnv";
import { prisma } from "../src/lib/prisma";
import { scheduledOperationHealth, scheduledOperationIsHealthy, SCHEDULED_OPERATIONS } from "../src/domain/scheduledOperations";

/** Aggregate-only Docker healthcheck; no case, party, evidence, or provider data is read. */
async function main() {
  const now = new Date();
  const rows = await prisma.scheduledOperationHeartbeat.findMany({
    where: { name: { in: SCHEDULED_OPERATIONS.map((operation) => operation.name) } },
  });
  const heartbeats = new Map(rows.map((row) => [row.name, row]));
  const operations = SCHEDULED_OPERATIONS.map((operation) => {
    const heartbeat = heartbeats.get(operation.name) ?? null;
    const health = scheduledOperationHealth(operation.intervalMs, heartbeat, now);
    return {
      name: operation.name,
      health,
      lastHeartbeatAt: heartbeat?.lastHeartbeatAt?.toISOString() ?? null,
    };
  });
  const healthy = operations.every((operation) => scheduledOperationIsHealthy(operation.health));
  console.log(JSON.stringify({ healthy, checkedAt: now.toISOString(), operations }));
  if (!healthy) process.exitCode = 1;
}

main()
  .catch(() => {
    console.error("Scheduled operations health could not be read.");
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
