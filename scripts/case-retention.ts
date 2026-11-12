import "../src/lib/loadEnv";
import { prisma } from "../src/lib/prisma";
import { approveCaseDeletion, attestDeletionCopy, completeCaseDeletion, eraseCaseDeletionObjects, freezeCaseDeletion, inventoryCaseDeletion, purgeCaseDeletionDatabase, requestCaseDeletion, resolveCaseOperation, reviewDeletionHold, RetentionError } from "../src/domain/retention";
import type { DeletionCopyStatus, RetentionHoldState } from "../src/generated/prisma";

// No arbitrary SQL, no age-based automatic erasure, and no --force option.
// Each action is explicit and authenticates the actor against current DB role.
async function main() {
  const [action, id, actorId, value, evidence, confirmation] = process.argv.slice(2);
  if (!action || !id || !actorId) throw new RetentionError("USAGE: case-retention <request|hold|approve|freeze|inventory|erase-objects|purge-database|attest|complete|resolve-operation|status> <case-or-deletion-id> <actor-id> [value] [sha256] [quiescence-confirmed]");
  let result: unknown;
  switch (action) {
    case "request": result = await requestCaseDeletion(id, actorId); break;
    case "hold": result = await reviewDeletionHold(id, actorId, value as RetentionHoldState, evidence); break;
    case "approve": result = await approveCaseDeletion(id, actorId, value); break;
    case "freeze": result = await freezeCaseDeletion(id, actorId); break;
    case "inventory": result = await inventoryCaseDeletion(id, actorId); break;
    case "erase-objects": await eraseCaseDeletionObjects(id, actorId); result = { stage: "object_attempt_finished" }; break;
    case "purge-database": await purgeCaseDeletionDatabase(id, actorId); result = { stage: "local_purge_finished", externalCopies: "pending" }; break;
    case "attest": result = await attestDeletionCopy(id, actorId, value, evidence as DeletionCopyStatus, confirmation); break;
    case "complete": result = await completeCaseDeletion(id, actorId); break;
    case "resolve-operation": result = await resolveCaseOperation(id, actorId, value, evidence === "quiescence-confirmed"); break;
    case "status": {
      if ((await prisma.user.findUnique({ where: { id: actorId } }))?.globalRole !== "ADMIN") throw new RetentionError("FORBIDDEN");
      const job = await prisma.caseDeletion.findUniqueOrThrow({ where: { id }, include: { copies: { select: { store: true, status: true, attestedAt: true } } } });
      result = { id: job.id, status: job.status, holdState: job.holdState, eligibleAt: job.eligibleAt, localPurgedAt: job.localPurgedAt, completedAt: job.completedAt, copies: job.copies };
      break;
    }
    default: throw new RetentionError("UNKNOWN_ACTION");
  }
  // Do not put storage keys, source content or evidence text into terminal logs.
  const safe = result && typeof result === "object" ? result as Record<string, unknown> : {};
  console.log(JSON.stringify(Object.fromEntries(Object.entries(safe).filter(([key]) => ["id", "status", "stage", "holdState", "eligibleAt", "localPurgedAt", "completedAt", "externalCopies", "copies"].includes(key)))));
}
main().catch(error => { console.error(error instanceof RetentionError ? error.code : "RETENTION_ACTION_FAILED"); process.exitCode = 1; }).finally(() => prisma.$disconnect());
