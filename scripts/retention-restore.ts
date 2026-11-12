import "../src/lib/loadEnv";
import { prisma } from "../src/lib/prisma";
import { assertRetentionRestoreSafe, initializeDeletionLedger, readDeletionLedger, reconcileRestoredObjects, replayDeletionTombstones } from "../src/domain/retentionLedger";
async function main() {
  const [action, actorId, digest, confirmation] = process.argv.slice(2);
  if (action === "initialize") await initializeDeletionLedger();
  else if (action === "verify") { await readDeletionLedger(); await assertRetentionRestoreSafe(); }
  else if (action === "replay") await replayDeletionTombstones(actorId, digest, confirmation === "services-stopped");
  else if (action === "reconcile-objects") await reconcileRestoredObjects(actorId, digest, confirmation, process.argv[6] === "services-stopped");
  else throw new Error("RETENTION_RESTORE_USAGE");
  console.log(JSON.stringify({ action, status: "passed" }));
}
main().catch(() => { console.error("RETENTION_RESTORE_CHECK_FAILED"); process.exitCode = 1; }).finally(() => prisma.$disconnect());
