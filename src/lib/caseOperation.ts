import { AsyncLocalStorage } from "node:async_hooks";
import { prisma } from "./prisma";

/** Deliberately indistinguishable from a missing case at public boundaries. */
export class CaseUnavailableError extends Error {
  constructor() { super("Case not found."); this.name = "CaseUnavailableError"; }
}

type Operation = { id: string; uncertain: boolean; hasExternalEffect: boolean; pending: Set<Promise<unknown>>; closing: boolean };
const operations = new AsyncLocalStorage<ReadonlyMap<string, Operation>>();

/** An admitted, tracked operation may finish inventory after admission closes. */
async function appendStorageKey(operation: Operation, caseId: string, storageKey: string): Promise<void> {
  // A pre-existing operation may append inventory after a freeze. Purge
  // waits for its ACTIVE/UNCERTAIN record; never lose a late object's key.
  const updated = await prisma.caseOperation.updateMany({
    where: { id: operation.id, caseId, status: "ACTIVE" },
    data: { storageKeys: { push: storageKey } },
  });
  if (updated.count !== 1) throw new CaseUnavailableError();
  operation.hasExternalEffect = true;
}

/** Register the key durably BEFORE sending any bytes to object storage. */
export async function registerCaseOperationStorageKey(caseId: string, storageKey: string): Promise<void> {
  const operation = operations.getStore()?.get(caseId);
  if (!operation) throw new Error("A case operation must span storage and its final publication.");
  if (operation.closing) throw new CaseUnavailableError();
  const execution = appendStorageKey(operation, caseId, storageKey);
  operation.pending.add(execution);
  try { await execution; }
  catch (error) { operation.uncertain = true; throw error; }
  finally { operation.pending.delete(execution); }
}

async function requireActive(operation: Operation): Promise<void> {
  if (!await prisma.caseOperation.findFirst({ where: { id: operation.id, status: "ACTIVE" }, select: { id: true } })) throw new CaseUnavailableError();
}
async function settlePending(operation: Operation): Promise<void> {
  while (operation.pending.size) await Promise.allSettled([...operation.pending]);
}

/** Use around I/O whose exception a domain function translates into an outcome. */
export async function caseOperationExternalIO<T>(caseId: string, fn: () => Promise<T>): Promise<T> {
  const operation = operations.getStore()?.get(caseId);
  if (!operation) throw new Error("Case external I/O requires an active operation.");
  if (operation.closing) throw new CaseUnavailableError();
  const execution = (async () => {
    await requireActive(operation);
    operation.hasExternalEffect = true;
    try {
      const result = await fn();
      if (result !== null && typeof result === "object"
        && (("ok" in result && result.ok === false) || ("status" in result && result.status === "unavailable"))) operation.uncertain = true;
      return result;
    } catch (error) { operation.uncertain = true; throw error; }
  })();
  operation.pending.add(execution);
  try { return await execution; } finally { operation.pending.delete(execution); }
}

/**
 * Durable quiescence barrier. It has no timeout/lease: process death leaves
 * ACTIVE, and uncertain effects need explicit operator evidence to resolve.
 * The callback must await ALL work, including rollback and DB publication.
 */
export async function withCaseOperation<T>(
  caseId: string,
  kind: string,
  fn: () => Promise<T>,
  options: { storageKey?: string } = {},
): Promise<T> {
  const parent = operations.getStore();
  const nested = parent?.get(caseId);
  if (nested) {
    if (nested.closing) throw new CaseUnavailableError();
    const execution = (async () => {
      try {
        await requireActive(nested);
        if (options.storageKey) await appendStorageKey(nested, caseId, options.storageKey);
        const result = await fn();
        if (nested.hasExternalEffect && result !== null && typeof result === "object" && "ok" in result && result.ok === false) nested.uncertain = true;
        return result;
      } catch (error) { nested.uncertain = true; throw error; }
    })();
    nested.pending.add(execution);
    try { return await execution; } finally { nested.pending.delete(execution); }
  }
  const row = await prisma.$transaction(async tx => {
    const cases = await tx.$queryRaw<Array<{ deletionStartedAt: Date | null }>>`
      SELECT "deletionStartedAt" FROM "Case" WHERE "id" = ${caseId} FOR UPDATE
    `;
    if (cases.length !== 1 || cases[0].deletionStartedAt !== null) throw new CaseUnavailableError();
    return tx.caseOperation.create({ data: { caseId, kind, status: "ACTIVE", storageKeys: options.storageKey ? [options.storageKey] : [] } });
  });
  const operation: Operation = { id: row.id, uncertain: false, hasExternalEffect: Boolean(options.storageKey), pending: new Set(), closing: false };
  const context = new Map(parent);
  context.set(caseId, operation);
  return operations.run(context, async () => {
    try {
      const result = await fn();
      // Close admission synchronously before draining or awaiting the terminal
      // DB update. Detached continuations cannot enter that asynchronous gap.
      operation.closing = true;
      await settlePending(operation);
      // Some domain APIs translate publication/provider failure into ok:false.
      // Once I/O started, this must not erase the need for operator review.
      const failedOutcome = result !== null && typeof result === "object" && "ok" in result && result.ok === false;
      const uncertain = operation.uncertain || (operation.hasExternalEffect && failedOutcome);
      const updated = await prisma.caseOperation.updateMany({
        where: { id: operation.id, status: "ACTIVE" },
        data: { status: uncertain ? "UNCERTAIN" : "SUCCEEDED", finishedAt: new Date() },
      });
      if (updated.count !== 1) throw new CaseUnavailableError();
      return result;
    } catch (error) {
      operation.closing = true;
      await settlePending(operation);
      // If this persistence fails, the pre-existing ACTIVE record still blocks.
      try { await prisma.caseOperation.updateMany({ where: { id: operation.id, status: "ACTIVE" }, data: { status: "UNCERTAIN", finishedAt: new Date() } }); }
      catch { console.error("Case operation requires operator review."); }
      throw error;
    }
  });
}
