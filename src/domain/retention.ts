/** Reviewed whole-case erasure. No timer grants permission to delete. */
import { createHash } from "node:crypto";
import { Client } from "pg";
import type { CaseDeletion, Prisma, RetentionHoldState, DeletionCopyStatus } from "../generated/prisma";
import { prisma } from "../lib/prisma";
import { isCaseStorageKey, listStoredKeysForCase, purgeStoredObject } from "../lib/storage";
import { computeEventHash, GENESIS_HASH } from "./events";
import { readDeletionLedger, recordDeletionTombstone } from "./retentionLedger";
import { verifyCaseDetailsRevisions } from "./caseDetailsRevision";

import { RETENTION_POLICY_VERSION, EXTERNAL_COPY_STORES, retentionReviewAt } from "./retentionPolicy";
export { RETENTION_POLICY_VERSION, EXTERNAL_COPY_STORES, retentionReviewAt } from "./retentionPolicy";
export class RetentionError extends Error {
  constructor(public readonly code: string) { super(code); this.name = "RetentionError"; }
}
function requireDigest(value: string) {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new RetentionError("EVIDENCE_DIGEST_REQUIRED");
  return value;
}
async function requireAdmin(tx: Prisma.TransactionClient, actorId: string) {
  if ((await tx.user.findUnique({ where: { id: actorId }, select: { globalRole: true } }))?.globalRole !== "ADMIN") throw new RetentionError("FORBIDDEN");
}
async function lockDeletion(tx: Prisma.TransactionClient, id: string) {
  const found = await tx.caseDeletion.findUnique({ where: { id }, select: { caseId: true } });
  if (!found) throw new RetentionError("NOT_FOUND");
  // Always lock Case before the deletion row, matching writers and the purger.
  await tx.$queryRaw`SELECT id FROM "Case" WHERE id=${found.caseId} FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM "CaseDeletion" WHERE id=${id} FOR UPDATE`;
  return tx.caseDeletion.findUniqueOrThrow({ where: { id } });
}
async function decision(tx: Prisma.TransactionClient, deletionId: string, actorId: string, action: string, evidenceDigest: string) {
  await tx.caseDeletionDecision.create({ data: { deletionId, actorId, action, evidenceDigest: requireDigest(evidenceDigest) } });
}
async function checkAuthorized(tx: Prisma.TransactionClient, job: CaseDeletion) {
  if (!job.approvedAt || !job.approvalDigest || job.holdState !== "CLEAR" || job.policyVersion !== RETENTION_POLICY_VERSION) throw new RetentionError("DELETION_NOT_APPROVED");
  if (job.eligibleAt > new Date()) throw new RetentionError("REVIEW_NOT_DUE");
  const c = await tx.case.findUnique({ where: { id: job.caseId }, select: { state: true, closedAt: true } });
  if (!c || c.state !== "CLOSED" || !c.closedAt || retentionReviewAt(c.closedAt) > new Date()) throw new RetentionError("CASE_NOT_ELIGIBLE");
  if (await tx.contestation.count({ where: { caseId: job.caseId, status: { in: ["OPEN", "RESPONDED"] } } })) throw new RetentionError("ACTIVE_CONTESTATION");
}
async function verifyChain(tx: Prisma.TransactionClient, caseId: string) {
  const events = await tx.event.findMany({ where: { caseId }, orderBy: { seq: "asc" } });
  let prevHash = GENESIS_HASH;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const hash = computeEventHash({ prevHash, payload: e.payload, actorId: e.actorId, seq: i + 1, createdAtIso: e.createdAt.toISOString() });
    if (e.seq !== i + 1 || e.prevHash !== prevHash || e.hash !== hash) throw new RetentionError("EVENT_CHAIN_INVALID");
    prevHash = e.hash;
  }
  const revisions = await tx.caseDetailsRevision.findMany({ where: { caseId } });
  if (verifyCaseDetailsRevisions(events, revisions).issues.length) throw new RetentionError("CASE_REVISION_INTEGRITY_INVALID");
  await tx.$executeRaw`SELECT public.retention_assert_links(${caseId})`;
}

export async function requestCaseDeletion(caseId: string, actorId: string) {
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Case" WHERE id=${caseId} FOR UPDATE`;
    const [c, actor, existing] = await Promise.all([
      tx.case.findUnique({ where: { id: caseId } }),
      tx.user.findUnique({ where: { id: actorId }, select: { globalRole: true } }),
      tx.caseDeletion.findUnique({ where: { caseId } }),
    ]);
    if (!actor || (actor.globalRole !== "ADMIN" && (!c || ![c.complainantId, c.respondentId].includes(actorId)) && existing?.requestedById !== actorId)) throw new RetentionError("FORBIDDEN");
    if (existing) return existing;
    if (!c || c.state !== "CLOSED" || !c.closedAt) throw new RetentionError("CASE_MUST_BE_CLOSED");
    return tx.caseDeletion.create({ data: { caseId, policyVersion: RETENTION_POLICY_VERSION, eligibleAt: retentionReviewAt(c.closedAt), requestedById: actorId, copies: { create: EXTERNAL_COPY_STORES.map(store => ({ store })) } } });
  });
}

export async function reviewDeletionHold(id: string, actorId: string, state: RetentionHoldState, evidenceDigest: string) {
  if (!["UNKNOWN", "CLEAR", "HELD"].includes(state)) throw new RetentionError("INVALID_HOLD");
  requireDigest(evidenceDigest);
  return prisma.$transaction(async tx => {
    await requireAdmin(tx, actorId);
    const job = await lockDeletion(tx, id);
    if (job.completedAt) throw new RetentionError("CONTROLLED_SCOPE_ALREADY_COMPLETED");
    await decision(tx, id, actorId, `HOLD_${state}`, evidenceDigest);
    // Changing a hold requires a fresh, explicit deletion decision. A hold
    // waits for the current object operation, then prevents the next one.
    return tx.caseDeletion.update({ where: { id }, data: { holdState: state, holdEvidenceDigest: evidenceDigest, approvedAt: null, approvedById: null, approvalDigest: null, status: job.localPurgedAt ? "LOCAL_PURGED" : job.frozenAt ? "FROZEN" : "REQUESTED" } });
  });
}

export async function approveCaseDeletion(id: string, actorId: string, evidenceDigest: string) {
  requireDigest(evidenceDigest);
  return prisma.$transaction(async tx => {
    await requireAdmin(tx, actorId);
    const job = await lockDeletion(tx, id);
    if (job.localPurgedAt) throw new RetentionError("CONTENT_ALREADY_PURGED");
    await checkAuthorized(tx, { ...job, approvedAt: new Date(), approvalDigest: evidenceDigest });
    await decision(tx, id, actorId, "APPROVE_WHOLE_CASE_ERASURE", evidenceDigest);
    return tx.caseDeletion.update({ where: { id }, data: { approvedAt: new Date(), approvedById: actorId, approvalDigest: evidenceDigest, status: job.frozenAt ? "FROZEN" : "APPROVED" } });
  });
}

export async function freezeCaseDeletion(id: string, actorId: string) {
  const frozen = await prisma.$transaction(async tx => {
    await requireAdmin(tx, actorId);
    const job = await lockDeletion(tx, id);
    if (job.localPurgedAt) return job;
    await checkAuthorized(tx, job);
    if (job.frozenAt) return job;
    await verifyChain(tx, job.caseId);
    const now = new Date();
    await tx.case.update({ where: { id: job.caseId }, data: { deletionStartedAt: now } });
    return tx.caseDeletion.update({ where: { id }, data: { frozenAt: now, status: "FROZEN" } });
  });
  await recordDeletionTombstone(frozen);
  return frozen;
}

/** No elapsed-time escape hatch. The operator must prove that the process and
 * all delegated I/O have stopped; its assertion and evidence digest are kept. */
export async function resolveCaseOperation(operationId: string, actorId: string, evidenceDigest: string, quiescenceConfirmed: boolean) {
  requireDigest(evidenceDigest);
  if (quiescenceConfirmed !== true) throw new RetentionError("QUIESCENCE_REQUIRED");
  return prisma.$transaction(async tx => {
    await requireAdmin(tx, actorId);
    const op = await tx.caseOperation.findUniqueOrThrow({ where: { id: operationId } });
    const job = await tx.caseDeletion.findUniqueOrThrow({ where: { caseId: op.caseId } });
    await lockDeletion(tx, job.id);
    if (!job.frozenAt || job.localPurgedAt) throw new RetentionError("FROZEN_CASE_REQUIRED");
    await decision(tx, job.id, actorId, "OPERATOR_ASSERTED_PROCESS_AND_IO_QUIESCENCE", evidenceDigest);
    return tx.caseOperation.update({ where: { id: operationId }, data: { status: "RESOLVED", finishedAt: new Date(), resolutionEvidenceDigest: evidenceDigest } });
  });
}

async function ensureDrained(tx: Prisma.TransactionClient, job: CaseDeletion) {
  await checkAuthorized(tx, job);
  if (!job.frozenAt) throw new RetentionError("CASE_NOT_FROZEN");
  if (await tx.caseOperation.count({ where: { caseId: job.caseId, status: { in: ["ACTIVE", "UNCERTAIN"] } } })) throw new RetentionError("OPERATIONS_NOT_DRAINED");
}

export async function inventoryCaseDeletion(id: string, actorId: string) {
  return prisma.$transaction(async tx => {
    await requireAdmin(tx, actorId);
    const job = await lockDeletion(tx, id);
    if (job.localPurgedAt) return job;
    await ensureDrained(tx, job);
    await verifyChain(tx, job.caseId);
    const c = await tx.case.findUniqueOrThrow({ where: { id: job.caseId }, select: { simulated: true } });
    const [evidence, exports, operations, storedKeys] = await Promise.all([
      tx.evidenceItem.findMany({ where: { caseId: job.caseId }, select: { storageKey: true } }),
      tx.exportBundle.findMany({ where: { caseId: job.caseId }, select: { storageKey: true } }),
      tx.caseOperation.findMany({ where: { caseId: job.caseId }, select: { storageKeys: true } }),
      listStoredKeysForCase(job.caseId, c.simulated),
    ]);
    const keys = [...new Set([...evidence, ...exports].map(x => x.storageKey).concat(operations.flatMap(x => x.storageKeys), storedKeys))];
    // A registered key outside its case namespace is corrupt ownership, not
    // permission to erase it. Inventory returns every version/marker key.
    for (const key of keys) {
      if (!isCaseStorageKey(key, job.caseId, c.simulated)) throw new RetentionError("STORAGE_OWNERSHIP_MISMATCH");
      if (await tx.evidenceItem.count({ where: { storageKey: key, caseId: { not: job.caseId } } }) || await tx.exportBundle.count({ where: { storageKey: key, caseId: { not: job.caseId } } })) throw new RetentionError("CROSS_CASE_STORAGE_REFERENCE");
      await tx.caseDeletionObject.upsert({ where: { deletionId_storageKey: { deletionId: id, storageKey: key } }, create: { deletionId: id, storageKey: key }, update: { erasedAt: null, backend: null, deletedVersions: null } });
    }
    return tx.caseDeletion.update({ where: { id }, data: { inventoryAt: new Date(), status: "ERASING" } });
  }, { timeout: 120_000 });
}

/** Per-object transaction serializes an in-flight erase with new holds. A
 * failed receipt commit leaves a retryable absent object, never completion. */
export async function eraseCaseDeletionObjects(id: string, actorId: string) {
  for (;;) {
    const processed = await prisma.$transaction(async tx => {
      await requireAdmin(tx, actorId);
      const job = await lockDeletion(tx, id);
      if (job.localPurgedAt) return false;
      await ensureDrained(tx, job);
      if (!job.inventoryAt || job.status !== "ERASING") throw new RetentionError("INVENTORY_REQUIRED");
      await recordDeletionTombstone(job);
      const object = await tx.caseDeletionObject.findFirst({ where: { deletionId: id, erasedAt: null }, orderBy: { id: "asc" } });
      if (!object) return false;
      const receipt = await purgeStoredObject(object.storageKey);
      await tx.caseDeletionObject.update({ where: { id: object.id }, data: { erasedAt: new Date(), backend: receipt.backend, deletedVersions: receipt.deletedVersions } });
      return true;
    }, { timeout: 120_000 });
    if (!processed) return;
  }
}

/** This credential belongs only to the operator process, never the web app.
 * SQL also requires the independently provisioned SECURITY DEFINER owner. */
export async function purgeCaseDeletionDatabase(id: string, actorId: string) {
  await requireAdmin(prisma, actorId);
  const job = await prisma.caseDeletion.findUniqueOrThrow({ where: { id } });
  await recordDeletionTombstone(job);
  if (!job.localPurgedAt) {
    const c = await prisma.case.findUniqueOrThrow({ where: { id: job.caseId }, select: { simulated: true } });
    if ((await listStoredKeysForCase(job.caseId, c.simulated)).length) throw new RetentionError("STORAGE_REINVENTORY_REQUIRED");
  }
  const connectionString = process.env.RETENTION_PURGER_DATABASE_URL;
  if (!connectionString || connectionString === process.env.DATABASE_URL) throw new RetentionError("SEPARATE_PURGER_CONNECTION_REQUIRED");
  const client = new Client({ connectionString, connectionTimeoutMillis: 5_000, query_timeout: 120_000 });
  try {
    await client.connect();
    await client.query("SELECT public.purge_case_content($1)", [id]);
  } finally { await client.end(); }
}

export async function attestDeletionCopy(id: string, actorId: string, store: string, status: DeletionCopyStatus, evidenceDigest: string) {
  requireDigest(evidenceDigest);
  if (!EXTERNAL_COPY_STORES.includes(store as typeof EXTERNAL_COPY_STORES[number]) || !["PENDING", "VERIFIED_DELETED", "VERIFIED_ABSENT", "OUTSIDE_CONTROL"].includes(status)) throw new RetentionError("INVALID_COPY_ATTESTATION");
  if (status === "OUTSIDE_CONTROL" && !["DOWNLOADED_EXPORTS", "EXTERNAL_REFERENCES"].includes(store)) throw new RetentionError("CONTROLLED_COPY_MUST_BE_RESOLVED");
  return prisma.$transaction(async tx => {
    await requireAdmin(tx, actorId);
    const job = await lockDeletion(tx, id);
    // Attest after local disposal so a pre-erasure assertion cannot conceal
    // a backup, log or mail copy made by the deletion activity itself.
    if (!job.localPurgedAt || job.completedAt) throw new RetentionError("LOCAL_PURGE_REQUIRED");
    await decision(tx, id, actorId, `OPERATOR_ATTESTATION_${store}_${status}`, evidenceDigest);
    return tx.caseDeletionCopy.update({ where: { deletionId_store: { deletionId: id, store } }, data: { status, evidenceDigest, attestedById: actorId, attestedAt: new Date() } });
  });
}

export async function completeCaseDeletion(id: string, actorId: string) {
  return prisma.$transaction(async tx => {
    await requireAdmin(tx, actorId);
    const job = await lockDeletion(tx, id);
    if (!job.localPurgedAt) throw new RetentionError("LOCAL_PURGE_REQUIRED");
    if (job.holdState !== "CLEAR") throw new RetentionError("DELETION_HOLD_UNRESOLVED");
    const tombstone = (await readDeletionLedger()).entries.find(e => e.deletionId === id);
    if (!tombstone || job.restoredObjectsPending || (await listStoredKeysForCase(job.caseId, tombstone.simulated)).length) throw new RetentionError("RESTORED_OBJECTS_PENDING");
    if (job.completedAt) return job;
    const copies = await tx.caseDeletionCopy.findMany({ where: { deletionId: id } });
    if (copies.length !== EXTERNAL_COPY_STORES.length || EXTERNAL_COPY_STORES.some(store => !copies.some(copy => copy.store === store && copy.status !== "PENDING" && copy.evidenceDigest && copy.attestedAt))) throw new RetentionError("EXTERNAL_COPIES_PENDING");
    // COMPLETED means controlled copies resolved with explicit operator evidence;
    // OUTSIDE_CONTROL remains visible and never becomes a global erasure claim.
    const digest = createHash("sha256").update(JSON.stringify(copies.map(c => [c.store, c.status, c.evidenceDigest]).sort())).digest("hex");
    await decision(tx, id, actorId, "CONTROLLED_SCOPE_COMPLETED", digest);
    return tx.caseDeletion.update({ where: { id }, data: { status: "COMPLETED", completedAt: new Date() } });
  });
}
