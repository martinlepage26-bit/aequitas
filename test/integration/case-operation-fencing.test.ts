import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../../src/lib/prisma";
import { CaseUnavailableError, caseOperationExternalIO, registerCaseOperationStorageKey, withCaseOperation } from "../../src/lib/caseOperation";
import { caseReadAccess } from "../../src/domain/caseAccess";
import { appendEvent } from "../../src/domain/events";
import { claimAgentCase, findEligibleAgentCases } from "../../src/domain/caseAgent/scheduler";
import { buildExportRecord } from "../../src/domain/exportBundle";
import { downloadCleanEvidence } from "../../src/domain/evidenceAccess";
import { readPartyOutcomeCitation } from "../../src/domain/partyOutcomeCitationAccess";
import { readClaimGraph } from "../../src/domain/claimWrites";
import { readPartyOutcomes } from "../../src/domain/partyOutcome";
import { readResolutionView } from "../../src/domain/resolution";

const session = vi.hoisted(() => ({ userId: "", globalRole: "COMPLAINANT" as const, authMethod: "passkey" as const }));
vi.mock("../../src/lib/session", () => ({ requireSession: async () => ({ session }) }));
import { GET as exportGet } from "../../src/app/api/cases/[caseId]/export/route";

let complainantId: string;
let respondentId: string;
beforeAll(async () => {
  const id = randomUUID();
  complainantId = (await prisma.user.create({ data: { email: `fence-c-${id}@example.org`, displayName: "Fencing fixture", globalRole: "COMPLAINANT" } })).id;
  respondentId = (await prisma.user.create({ data: { email: `fence-r-${id}@example.org`, displayName: "Fencing fixture", globalRole: "RESPONDENT" } })).id;
  session.userId = complainantId;
});
// Append-only/frozen fixtures deliberately remain in this disposable test DB.
function seed() {
  return prisma.case.create({ data: { referenceNumber: `AE-FENCE-${randomUUID()}`, complainantId, respondentId, state: "OPEN", agentManaged: true, simulated: true } });
}
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

describe("durable case operation fencing", () => {
  it("retains inventory added by an existing operation after freeze and refuses independent work", async () => {
    const row = await seed();
    const started = deferred();
    const frozen = deferred();
    const inventoried = deferred();
    const finish = deferred();
    const key = `simulated/${row.id}/late-upload`;
    const running = withCaseOperation(row.id, "upload-publication", async () => {
      started.resolve();
      await frozen.promise;
      await withCaseOperation(row.id, "storage-upload", async () => {
        const durable = await prisma.caseOperation.findFirstOrThrow({ where: { caseId: row.id } });
        expect(durable.storageKeys).toContain(key);
        expect(durable.status).toBe("ACTIVE");
        inventoried.resolve();
      }, { storageKey: key });
      await finish.promise;
      return "published";
    });
    await started.promise;
    await prisma.case.update({ where: { id: row.id }, data: { deletionStartedAt: new Date() } });
    await expect(withCaseOperation(row.id, "new-export", async () => "unexpected")).rejects.toBeInstanceOf(CaseUnavailableError);
    frozen.resolve();
    await inventoried.promise;
    expect(await prisma.caseOperation.count({ where: { caseId: row.id, status: "ACTIVE" } })).toBe(1);
    finish.resolve();
    expect(await running).toBe("published");
    const durable = await prisma.caseOperation.findFirstOrThrow({ where: { caseId: row.id } });
    expect(durable.status).toBe("SUCCEEDED");
    expect(durable.storageKeys).toContain(key);
  });

  it("serializes admission against a freeze transaction holding the Case lock", async () => {
    const row = await seed();
    const locked = deferred();
    const release = deferred();
    const freeze = prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Case" WHERE id=${row.id} FOR UPDATE`;
      await tx.case.update({ where: { id: row.id }, data: { deletionStartedAt: new Date() } });
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    const callback = vi.fn(async () => "unexpected");
    const admission = withCaseOperation(row.id, "queued", callback);
    release.resolve();
    await freeze;
    await expect(admission).rejects.toBeInstanceOf(CaseUnavailableError);
    expect(callback).not.toHaveBeenCalled();
    expect(await prisma.caseOperation.count({ where: { caseId: row.id } })).toBe(0);
  });

  it("leaves failed publication after a frozen upload UNCERTAIN with its key", async () => {
    const row = await seed();
    const key = `simulated/${row.id}/unpublished`;
    await expect(withCaseOperation(row.id, "upload-publication", async () => {
      await withCaseOperation(row.id, "storage-upload", async () => {}, { storageKey: key });
      await prisma.case.update({ where: { id: row.id }, data: { deletionStartedAt: new Date() } });
      await prisma.$transaction(tx => appendEvent(tx, { caseId: row.id, actorId: complainantId, type: "EVIDENCE_ACCESSED", payload: {} }));
    })).rejects.toBeInstanceOf(CaseUnavailableError);
    const durable = await prisma.caseOperation.findFirstOrThrow({ where: { caseId: row.id } });
    expect(durable.status).toBe("UNCERTAIN");
    expect(durable.storageKeys).toContain(key);
  });

  it("keeps caught provider failures uncertain even when the outer handler returns success", async () => {
    const row = await seed();
    await withCaseOperation(row.id, "model-pass", async () => {
      try { await caseOperationExternalIO(row.id, async () => { throw new Error("lost response"); }); }
      catch { /* Existing handlers may translate failure into an escalation. */ }
      return { status: "escalated" };
    });
    expect((await prisma.caseOperation.findFirstOrThrow({ where: { caseId: row.id } })).status).toBe("UNCERTAIN");
  });

  it("waits for nested I/O even if the caller forgets to await it", async () => {
    const row = await seed();
    const entered = deferred();
    const release = deferred();
    let completed = false;
    const running = withCaseOperation(row.id, "outer", async () => {
      void caseOperationExternalIO(row.id, async () => { entered.resolve(); await release.promise; });
      return "done";
    }).then(result => { completed = true; return result; });
    await entered.promise;
    expect(completed).toBe(false);
    expect((await prisma.caseOperation.findFirstOrThrow({ where: { caseId: row.id } })).status).toBe("ACTIVE");
    release.resolve();
    expect(await running).toBe("done");
  });

  it("refuses a detached continuation after its operation has completed", async () => {
    const row = await seed();
    const release = deferred();
    const callback = vi.fn(async () => "too late");
    let continuation!: Promise<unknown>;
    await withCaseOperation(row.id, "outer", async () => {
      continuation = release.promise.then(() => withCaseOperation(row.id, "late", callback));
    });
    const assertion = expect(continuation).rejects.toBeInstanceOf(CaseUnavailableError);
    release.resolve();
    await assertion;
    expect(callback).not.toHaveBeenCalled();
  });

  it("finishes an admitted nested storage registration after the parent closes admission", async () => {
    const row = await seed();
    const entered = deferred();
    const release = deferred();
    const key = `simulated/${row.id}/admitted-before-close`;
    let nested!: Promise<void>;
    const running = withCaseOperation(row.id, "outer", async () => {
      nested = withCaseOperation(row.id, "storage-upload", async () => {
        expect((await prisma.caseOperation.findFirstOrThrow({ where: { caseId: row.id } })).storageKeys).toContain(key);
        entered.resolve();
        await release.promise;
      }, { storageKey: key });
      return "done";
    });
    await entered.promise;
    expect((await prisma.caseOperation.findFirstOrThrow({ where: { caseId: row.id } })).status).toBe("ACTIVE");
    release.resolve();
    await nested;
    expect(await running).toBe("done");
  });

  it.each(["SUCCEEDED", "UNCERTAIN"] as const)("closes late admission while the %s terminal write is pending", async terminalStatus => {
    const row = await seed();
    const terminalEntered = deferred();
    const releaseTerminal = deferred();
    const releaseLate = deferred();
    const nestedCallback = vi.fn(async () => "must not run");
    const ioCallback = vi.fn(async () => "must not run");
    let lateNested!: Promise<unknown>;
    let lateIO!: Promise<unknown>;
    let lateKey!: Promise<unknown>;
    const update = prisma.caseOperation.updateMany.bind(prisma.caseOperation);
    const spy = vi.spyOn(prisma.caseOperation, "updateMany").mockImplementation(args => {
      const pending = (async () => {
        if (args.data.status === terminalStatus) {
          terminalEntered.resolve();
          await releaseTerminal.promise;
        }
        return update(args);
      })();
      // PrismaPromise's extra public contract is its branded toStringTag.
      Object.defineProperty(pending, Symbol.toStringTag, { value: "PrismaPromise" });
      return pending as ReturnType<typeof update>;
    });
    const running = withCaseOperation(row.id, "outer", async () => {
      lateNested = releaseLate.promise.then(() => withCaseOperation(row.id, "late", nestedCallback));
      lateIO = releaseLate.promise.then(() => caseOperationExternalIO(row.id, ioCallback));
      lateKey = releaseLate.promise.then(() => registerCaseOperationStorageKey(row.id, `simulated/${row.id}/too-late`));
      if (terminalStatus === "UNCERTAIN") throw new Error("outer failed");
      return "done";
    }).then(value => ({ value }), error => ({ error }));
    try {
      await terminalEntered.promise;
      expect((await prisma.caseOperation.findFirstOrThrow({ where: { caseId: row.id } })).status).toBe("ACTIVE");
      const lateResults = Promise.allSettled([lateNested, lateIO, lateKey]);
      releaseLate.resolve();
      for (const result of await lateResults) {
        expect(result.status).toBe("rejected");
        if (result.status === "rejected") expect(result.reason).toBeInstanceOf(CaseUnavailableError);
      }
      expect(nestedCallback).not.toHaveBeenCalled();
      expect(ioCallback).not.toHaveBeenCalled();
      expect((await prisma.caseOperation.findFirstOrThrow({ where: { caseId: row.id } })).storageKeys).toEqual([]);
    } finally {
      releaseLate.resolve();
      releaseTerminal.resolve();
      await running;
      spy.mockRestore();
    }
    expect((await prisma.caseOperation.findFirstOrThrow({ where: { caseId: row.id } })).status).toBe(terminalStatus);
  });

  it("blocks frozen case readers, independent export downloads and stale scheduler claims", async () => {
    const row = await seed();
    const [candidate] = await findEligibleAgentCases({ caseIds: [row.id] });
    expect(candidate).toBeDefined();
    const frozen = await prisma.case.update({ where: { id: row.id }, data: { deletionStartedAt: new Date() } });
    for (const role of ["COMPLAINANT", "RESPONDENT", "CASE_MANAGER", "ADMIN"] as const) {
      expect(caseReadAccess(frozen, { userId: complainantId, globalRole: role, isApprover: true })).toBeNull();
    }
    expect(await findEligibleAgentCases({ caseIds: [row.id] })).toEqual([]);
    expect(await claimAgentCase(candidate)).toBeNull();
    await expect(buildExportRecord(row.id)).rejects.toBeInstanceOf(CaseUnavailableError);
    const response = await exportGet(new Request(`http://localhost/api/cases/${row.id}/export`), { params: Promise.resolve({ caseId: row.id }) });
    expect(response.status).toBe(404);
    const actor = { caseId: row.id, actorId: complainantId, actorRole: "COMPLAINANT" as const };
    expect(await downloadCleanEvidence({ ...actor, evidenceId: "missing" })).toEqual({ ok: false, status: 404 });
    expect(await readPartyOutcomeCitation({ ...actor, outcomeId: "missing", citationId: "missing" })).toEqual({ ok: false, status: 404 });
    const viewer = { userId: complainantId, globalRole: "COMPLAINANT" as const, isApprover: false };
    expect(await readClaimGraph(row.id, viewer)).toBeNull();
    expect(await readPartyOutcomes(row.id, viewer)).toBeNull();
    expect(await readResolutionView(row.id, viewer)).toBeNull();
    expect(await prisma.caseOperation.count({ where: { caseId: row.id } })).toBe(0);
  });
});
