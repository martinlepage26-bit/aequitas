import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rmdir, unlink } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { z } from "zod";
import type { CaseDeletion } from "../generated/prisma";
import { prisma } from "../lib/prisma";
import { EXTERNAL_COPY_STORES } from "./retentionPolicy";
import { listStoredKeysForCase, purgeStoredObject } from "../lib/storage";

const entrySchema = z.object({
  deletionId: z.string().uuid(), caseId: z.string().uuid(), policyVersion: z.string().min(1).max(100),
  eligibleAt: z.iso.datetime(), requestedAt: z.iso.datetime(), requestedById: z.string().uuid(), frozenAt: z.iso.datetime(),
  simulated: z.boolean(),
}).strict();
const ledgerSchema = z.object({ version: z.literal(1), entries: z.array(entrySchema) }).strict();
export type DeletionLedger = z.infer<typeof ledgerSchema>;
function ledgerPath() {
  const path = process.env.RETENTION_LEDGER_PATH;
  if (process.env.RETENTION_ENFORCEMENT_ENABLED !== "true" || !path || !isAbsolute(path)) throw new Error("RETENTION_INDEPENDENT_LEDGER_REQUIRED");
  return path;
}
async function readAt(path: string, expectedDigest?: string): Promise<DeletionLedger> {
  const st = await lstat(path);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || (st.mode & 0o077) !== 0) throw new Error("RETENTION_LEDGER_PERMISSIONS_INVALID");
  const bytes = await readFile(path);
  if (expectedDigest && createHash("sha256").update(bytes).digest("hex") !== expectedDigest) throw new Error("RETENTION_LEDGER_DIGEST_MISMATCH");
  const parsed = ledgerSchema.parse(JSON.parse(bytes.toString("utf8")));
  if (new Set(parsed.entries.map(e => e.caseId)).size !== parsed.entries.length || new Set(parsed.entries.map(e => e.deletionId)).size !== parsed.entries.length) throw new Error("RETENTION_LEDGER_DUPLICATE");
  return parsed;
}
export async function readDeletionLedger() { return readAt(ledgerPath()); }
export async function initializeDeletionLedger() {
  const path = ledgerPath();
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(JSON.stringify({ version: 1, entries: [] }) + "\n"); await file.sync(); } finally { await file.close(); }
  const dir = await open(dirname(path), "r"); try { await dir.sync(); } finally { await dir.close(); }
}

/** The separate ledger is committed and fsynced before any destructive I/O.
 * A stale writer lock is never stolen by a timer; operator recovery must prove
 * that the prior process stopped. Store this outside the restored DB/volume. */
export async function recordDeletionTombstone(job: CaseDeletion) {
  const path = ledgerPath();
  if (!job.frozenAt) throw new Error("RETENTION_FREEZE_REQUIRED");
  const lock = `${path}.lock`;
  await mkdir(lock, { mode: 0o700 });
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    const ledger = await readAt(path);
    const existing = ledger.entries.find(e => e.caseId === job.caseId);
    if (existing) {
      if (existing.deletionId !== job.id) throw new Error("RETENTION_LEDGER_CONFLICT");
      return;
    }
    const c = await prisma.case.findUniqueOrThrow({ where: { id: job.caseId }, select: { simulated: true } });
    ledger.entries.push({ deletionId: job.id, caseId: job.caseId, policyVersion: job.policyVersion, eligibleAt: job.eligibleAt.toISOString(), requestedAt: job.requestedAt.toISOString(), requestedById: job.requestedById, frozenAt: job.frozenAt.toISOString(), simulated: c.simulated });
    ledger.entries.sort((a, b) => a.caseId.localeCompare(b.caseId));
    const file = await open(tmp, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(ledger) + "\n"); await file.sync(); } finally { await file.close(); }
    await rename(tmp, path);
    const dir = await open(dirname(path), "r"); try { await dir.sync(); } finally { await dir.close(); }
  } finally {
    await unlink(tmp).catch(error => { if (error.code !== "ENOENT") throw error; });
    await rmdir(lock);
  }
}

/** Called before serving or dispatching background work. An older backup must
 * be quarantined against the independently retained ledger before startup. */
export async function assertRetentionRestoreSafe() {
  if (process.env.RETENTION_ENFORCEMENT_ENABLED !== "true") return;
  const ledger = await readDeletionLedger();
  for (const entry of ledger.entries) {
    const [c, job] = await Promise.all([
      prisma.case.findUnique({ where: { id: entry.caseId }, select: { deletionStartedAt: true } }),
      prisma.caseDeletion.findUnique({ where: { caseId: entry.caseId }, select: { id: true, frozenAt: true, restoredObjectsPending: true } }),
    ]);
    if (!job?.frozenAt || job.id !== entry.deletionId || (c && !c.deletionStartedAt)) throw new Error("RETENTION_RESTORE_REPLAY_REQUIRED");
    if (job.restoredObjectsPending || (!c && (await listStoredKeysForCase(entry.caseId, entry.simulated)).length)) throw new Error("RETENTION_RESTORED_OBJECTS_PENDING");
  }
  // Reject an omitted/truncated external ledger, even if valid JSON.
  const frozen = await prisma.caseDeletion.findMany({ where: { frozenAt: { not: null } }, select: { caseId: true } });
  if (frozen.some(job => !ledger.entries.some(entry => entry.caseId === job.caseId))) throw new Error("RETENTION_LEDGER_INCOMPLETE");
}

/** Offline restore replay only quarantines content; it never fabricates new
 * deletion permission. Run with services stopped and an independently checked
 * current ledger SHA-256. Old approvals and operation outcomes are not trusted. */
export async function replayDeletionTombstones(actorId: string, expectedSha256: string, offlineConfirmed: boolean) {
  if (!offlineConfirmed || !/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error("RETENTION_OFFLINE_REPLAY_CONFIRMATION_REQUIRED");
  const path = ledgerPath();
  const ledger = await readAt(path, expectedSha256);
  if ((await prisma.user.findUnique({ where: { id: actorId }, select: { globalRole: true } }))?.globalRole !== "ADMIN") throw new Error("FORBIDDEN");
  for (const entry of ledger.entries) {
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Case" WHERE id=${entry.caseId} FOR UPDATE`;
      const c = await tx.case.findUnique({ where: { id: entry.caseId }, select: { deletionStartedAt: true } });
      const old = await tx.caseDeletion.findUnique({ where: { caseId: entry.caseId } });
      if (old && old.id !== entry.deletionId) throw new Error("RETENTION_LEDGER_CONFLICT");
      if (c && !c.deletionStartedAt) await tx.case.update({ where: { id: entry.caseId }, data: { deletionStartedAt: new Date(entry.frozenAt) } });
      if (!old) {
        await tx.caseDeletion.create({ data: { id: entry.deletionId, caseId: entry.caseId, policyVersion: entry.policyVersion, eligibleAt: new Date(entry.eligibleAt), requestedAt: new Date(entry.requestedAt), requestedById: entry.requestedById, frozenAt: new Date(entry.frozenAt), status: "FROZEN", copies: { create: EXTERNAL_COPY_STORES.map(store => ({ store })) } } });
      } else if (!old.localPurgedAt) {
        await tx.caseDeletion.update({ where: { id: old.id }, data: { frozenAt: new Date(entry.frozenAt), status: "FROZEN", holdState: "UNKNOWN", approvedAt: null, approvedById: null, approvalDigest: null, inventoryAt: null } });
      }
      await tx.caseDeletionDecision.create({ data: { deletionId: entry.deletionId, actorId, action: "OFFLINE_RESTORE_QUARANTINE_REPLAY", evidenceDigest: expectedSha256 } });
      if (!c && (await listStoredKeysForCase(entry.caseId, entry.simulated)).length) {
        await tx.caseDeletion.update({ where: { id: entry.deletionId }, data: { restoredObjectsPending: true, completedAt: null, status: old?.localPurgedAt ? "LOCAL_PURGED" : "FROZEN" } });
        await tx.caseDeletionCopy.upsert({ where: { deletionId_store: { deletionId: entry.deletionId, store: "OBJECT_SNAPSHOTS" } },
          create: { deletionId: entry.deletionId, store: "OBJECT_SNAPSHOTS" }, update: { status: "PENDING", evidenceDigest: null, attestedAt: null, attestedById: null } });
      }
    });
  }
  await assertRetentionRestoreSafe();
  return { quarantined: ledger.entries.length };
}

/** Explicitly reviewed disposal of an old object archive restored beside a
 * post-purge database. The ledger identifies its namespace without a Case row.
 * Startup remains blocked until this succeeds and external copies stay pending. */
export async function reconcileRestoredObjects(deletionId: string, actorId: string, evidenceDigest: string, offlineConfirmed: boolean) {
  if (!offlineConfirmed || !/^[a-f0-9]{64}$/.test(evidenceDigest)) throw new Error("RETENTION_OFFLINE_REVIEW_REQUIRED");
  const entry = (await readDeletionLedger()).entries.find(e => e.deletionId === deletionId);
  if (!entry) throw new Error("RETENTION_TOMBSTONE_REQUIRED");
  return prisma.$transaction(async tx => {
    if ((await tx.user.findUnique({ where: { id: actorId }, select: { globalRole: true } }))?.globalRole !== "ADMIN") throw new Error("FORBIDDEN");
    await tx.$queryRaw`SELECT id FROM "CaseDeletion" WHERE id=${deletionId} FOR UPDATE`;
    const job = await tx.caseDeletion.findUniqueOrThrow({ where: { id: deletionId } });
    if (job.caseId !== entry.caseId || !job.restoredObjectsPending || job.holdState !== "CLEAR"
      || await tx.case.count({ where: { id: entry.caseId } })
      || await tx.caseOperation.count({ where: { caseId: entry.caseId, status: { in: ["ACTIVE", "UNCERTAIN"] } } })) throw new Error("RETENTION_RESTORED_OBJECTS_NOT_AUTHORIZED");
    await tx.caseDeletionDecision.create({ data: { deletionId, actorId, action: "OFFLINE_RESTORED_OBJECT_ERASURE_REVIEW", evidenceDigest } });
    const keys = await listStoredKeysForCase(entry.caseId, entry.simulated);
    for (const key of keys) await purgeStoredObject(key);
    if ((await listStoredKeysForCase(entry.caseId, entry.simulated)).length) throw new Error("RETENTION_RESTORED_OBJECTS_PENDING");
    await tx.caseDeletion.update({ where: { id: deletionId }, data: { restoredObjectsPending: false } });
    return { erasedObjects: keys.length };
  }, { timeout: 120_000 });
}
