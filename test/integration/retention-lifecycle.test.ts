import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../../src/lib/prisma";
import * as storage from "../../src/lib/storage";
import { appendEvent } from "../../src/domain/events";
import { approveCaseDeletion, attestDeletionCopy, completeCaseDeletion, eraseCaseDeletionObjects, EXTERNAL_COPY_STORES, freezeCaseDeletion, inventoryCaseDeletion, purgeCaseDeletionDatabase, requestCaseDeletion, resolveCaseOperation, reviewDeletionHold } from "../../src/domain/retention";
import { initializeDeletionLedger, recordDeletionTombstone } from "../../src/domain/retentionLedger";

const digest = createHash("sha256").update("Synthetic reviewed retention decision").digest("hex");
let directory: string;
let admin: { id: string };
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "aequitas-retention-integration-"));
  process.env.STORAGE_LOCAL_DIR = join(directory, "objects");
  await mkdir(process.env.STORAGE_LOCAL_DIR);
  process.env.RETENTION_ENFORCEMENT_ENABLED = "true";
  process.env.RETENTION_LEDGER_PATH = join(directory, "independent-ledger.json");
  await initializeDeletionLedger();
  admin = await prisma.user.create({ data: { email: `retention-admin-${randomUUID()}@example.com`, displayName: "Synthetic reviewer", globalRole: "ADMIN" } });
});
afterAll(async () => { vi.restoreAllMocks(); await prisma.$disconnect(); await rm(directory, { recursive: true, force: true }); });

async function fixture(closedAt = new Date("2000-02-29T10:20:30.000Z")) {
  const [owner, respondent] = await Promise.all(["COMPLAINANT", "RESPONDENT"].map(globalRole => prisma.user.create({ data: { email: `retention-party-${randomUUID()}@example.com`, displayName: "Synthetic party", globalRole: globalRole as "COMPLAINANT" | "RESPONDENT" } })));
  const row = await prisma.case.create({ data: { referenceNumber: `RET-${randomUUID()}`, state: "CLOSED", simulated: true, closedAt, complainantId: owner.id, respondentId: respondent.id, disputeDescription: "Private synthetic history" } });
  const content = Buffer.from("Synthetic evidence for erasure");
  const key = storage.evidenceObjectKey(true, row.id, randomUUID());
  await storage.uploadBuffer({ storageKey: key, buffer: content, mimeType: "text/plain" });
  const evidence = await prisma.evidenceItem.create({ data: { caseId: row.id, submittedById: owner.id, kind: "DOCUMENT", title: "Synthetic evidence", storageKey: key, sha256: createHash("sha256").update(content).digest("hex"), byteSize: content.length, mimeType: "text/plain", scanStatus: "CLEAN", simulated: true } });
  await prisma.chronologyEntry.create({ data: { caseId: row.id, submittedById: owner.id, occurredOn: new Date("1999-01-01"), title: "Synthetic event", description: "Legacy chronology content", locale: "en-CA" } });
  await prisma.$transaction(tx => appendEvent(tx, { caseId: row.id, actorId: owner.id, type: "CASE_CREATED", payload: { legacyText: "Historical personal content" } }));
  const job = await requestCaseDeletion(row.id, owner.id);
  return { row, owner, respondent, evidence, job, key };
}
async function completeGraph(f: Awaited<ReturnType<typeof fixture>>) {
  const caseId = f.row.id;
  const recommendation = await prisma.recommendation.create({ data: { caseId, status: "ISSUED", explanation: { private: "Legacy explanation" }, modelId: "synthetic", promptVersion: "1" } });
  const outcome = await prisma.partyOutcome.create({ data: { caseId, partyId: f.owner.id, version: 1, body: "Private outcome", locale: "en-CA", authoredById: admin.id, status: "ISSUED" } });
  const statement = await prisma.consentStatementVersion.create({ data: { version: Math.floor(Math.random() * 2_000_000_000), locale: "en-CA", body: "Shared consent statement", effectiveFrom: new Date() } });
  await prisma.consentRecord.create({ data: { caseId, recommendationId: recommendation.id, partyId: f.owner.id, state: "GIVEN", statementVersionId: statement.id, locale: "en-CA", authContext: { synthetic: true }, partyOutcomeId: outcome.id, partyOutcomeVersion: 1 } });
  await prisma.partyOutcomeCitation.create({ data: { partyOutcomeId: outcome.id, evidenceItemId: f.evidence.id, relevance: "Synthetic", startChar: 0, endChar: 9, sourceSha256: digest, extractedTextSha256: digest, extractionMethod: "text" } });
  await prisma.coiDeclaration.create({ data: { caseId, caseManagerId: admin.id, hasConflict: false } });
  await prisma.caseDetailsRevision.create({ data: { caseId, actorId: f.owner.id, before: { private: "Before" }, after: { private: "After" }, nonce: randomUUID() } });
  const source = await prisma.source.create({ data: { caseId, kind: "EVIDENCE_ITEM", title: "Private source", body: "Private source text", evidenceItemId: f.evidence.id, createdById: admin.id } });
  const claim = await prisma.claim.create({ data: { caseId, claimType: "FACTUAL", text: "Private claim", confidenceRationale: "Synthetic unverified claim", createdById: admin.id } });
  const merged = await prisma.claim.create({ data: { caseId, claimType: "FACTUAL", text: "Private merged claim", confidenceRationale: "Synthetic unverified claim", createdById: admin.id, mergedIntoId: claim.id, deletedAt: new Date(), deletionReason: "Historical version" } });
  await prisma.claimEvidenceLink.create({ data: { claimId: claim.id, sourceId: source.id, predicate: "SUPPORTS", excerpt: "Private source", createdById: admin.id, deletedAt: new Date() } });
  await prisma.claimRelationship.create({ data: { caseId, fromClaimId: claim.id, toClaimId: merged.id, predicate: "SUPPORTS", evidenceId: source.id, createdById: admin.id } });
  await prisma.assumption.create({ data: { caseId, text: "Private assumption", origin: "CASE_FRAMING", createdById: admin.id } });
  await prisma.casePipeline.create({ data: { caseId } });
  const proposal = await prisma.pipelineProposal.create({ data: { caseId, kind: "CLAIM", payload: { private: "Proposal" }, modelId: "synthetic", promptVersion: "1", acceptedClaimId: claim.id } });
  await prisma.contextFactor.create({ data: { caseId, factorType: "POLICY_VS_PRACTICE", description: "Private context", gapMap: {}, diagnosis: "NO_GAP_FOUND", evidenceId: source.id, proposalId: proposal.id, createdById: admin.id } });
  const synthesis = await prisma.synthesisVersion.create({ data: { caseId, version: 1, sections: { private: "Synthesis" }, sentenceMap: {}, diagE: "E", diagP: "P", diagC: "C", createdById: admin.id } });
  await prisma.reviewTrail.create({ data: { caseId, claimId: claim.id, synthesisId: synthesis.id, recommendationId: recommendation.id, reviewerId: admin.id, action: "APPROVED", rationale: "Private review", createdById: admin.id } });
  await prisma.contestation.create({ data: { caseId, targetType: "CLAIM", targetId: claim.id, grounds: "Private contestation", status: "WITHDRAWN", openedById: f.owner.id } });
  await prisma.positionStatement.create({ data: { caseId, partyId: f.owner.id, body: "Private position", locale: "en-CA" } });
  await prisma.notification.create({ data: { caseId, userId: f.owner.id, kind: "Private notification", locale: "en-CA" } });
  await prisma.case.update({ where: { id: caseId }, data: { currentRecommendationId: recommendation.id } });
  return { statement, claim, outcome, source };
}
async function authorizeAndFreeze(jobId: string) {
  await reviewDeletionHold(jobId, admin.id, "CLEAR", digest);
  await approveCaseDeletion(jobId, admin.id, digest);
  const job = await freezeCaseDeletion(jobId, admin.id);
  await recordDeletionTombstone(job);
  return job;
}

describe("reviewed whole-case erasure under separated database roles", () => {
  it("erases content and orphan files, preserves other cases/accounts, and keeps external copies pending", async () => {
    const f = await fixture();
    const other = await fixture();
    const graph = await completeGraph(f);
    const orphan = storage.evidenceObjectKey(true, f.row.id, "orphan-upload");
    const exportKey = `exports/simulated/${f.row.id}/${randomUUID()}.zip`;
    await storage.uploadBuffer({ storageKey: orphan, buffer: Buffer.from("Unpublished upload"), mimeType: "text/plain" });
    await storage.uploadBuffer({ storageKey: exportKey, buffer: Buffer.from("Archive copy"), mimeType: "application/zip" });
    await prisma.exportBundle.create({ data: { caseId: f.row.id, generatedById: f.owner.id, storageKey: exportKey, sha256: digest } });
    await expect(prisma.event.deleteMany({ where: { caseId: f.row.id } })).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRaw`SELECT public.purge_case_content(${f.job.id})`).rejects.toThrow(/permission denied/);
    await authorizeAndFreeze(f.job.id);
    await inventoryCaseDeletion(f.job.id, admin.id);
    expect(await prisma.caseDeletionObject.count({ where: { deletionId: f.job.id } })).toBe(3);
    await eraseCaseDeletionObjects(f.job.id, admin.id);
    await purgeCaseDeletionDatabase(f.job.id, admin.id);
    expect(await prisma.case.findUnique({ where: { id: f.row.id } })).toBeNull();
    expect(await prisma.event.count({ where: { caseId: f.row.id } })).toBe(0);
    expect(await prisma.chronologyEntry.count({ where: { caseId: f.row.id } })).toBe(0);
    expect(await prisma.evidenceItem.count({ where: { caseId: f.row.id } })).toBe(0);
    expect(await prisma.exportBundle.count({ where: { caseId: f.row.id } })).toBe(0);
    for (const table of ["PositionStatement", "Recommendation", "PartyOutcome", "ConsentRecord", "CoiDeclaration", "CaseDetailsRevision", "Notification", "Source", "Claim", "ClaimRelationship", "ReviewTrail", "Assumption", "CasePipeline", "PipelineProposal", "ContextFactor", "SynthesisVersion", "Contestation"]) {
      const rows = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM "${table}" WHERE "caseId"=$1`, f.row.id);
      expect(Number(rows[0].n), table).toBe(0);
    }
    expect(await prisma.partyOutcomeCitation.count({ where: { partyOutcomeId: graph.outcome.id } })).toBe(0);
    expect(await prisma.claimEvidenceLink.count({ where: { claimId: graph.claim.id } })).toBe(0);
    expect(await prisma.consentStatementVersion.findUnique({ where: { id: graph.statement.id } })).not.toBeNull();
    expect(await prisma.user.count({ where: { id: { in: [f.owner.id, f.respondent.id] } } })).toBe(2);
    expect(await prisma.case.findUnique({ where: { id: other.row.id } })).not.toBeNull();
    expect(await storage.downloadBuffer(other.key)).toEqual(Buffer.from("Synthetic evidence for erasure"));
    expect(await storage.listStoredKeysForCase(f.row.id, true)).toEqual([]);
    expect(await prisma.caseDeletion.findUniqueOrThrow({ where: { id: f.job.id } })).toMatchObject({ status: "LOCAL_PURGED", erasedObjectCount: 3, completedAt: null });
    await expect(completeCaseDeletion(f.job.id, admin.id)).rejects.toThrow("EXTERNAL_COPIES_PENDING");
    await expect(attestDeletionCopy(f.job.id, admin.id, "MODEL_PROVIDER", "OUTSIDE_CONTROL", digest)).rejects.toThrow("CONTROLLED_COPY_MUST_BE_RESOLVED");
    for (const store of EXTERNAL_COPY_STORES) await attestDeletionCopy(f.job.id, admin.id, store, store === "DOWNLOADED_EXPORTS" ? "OUTSIDE_CONTROL" : "VERIFIED_ABSENT", digest);
    await reviewDeletionHold(f.job.id, admin.id, "HELD", digest);
    expect((await prisma.caseDeletion.findUniqueOrThrow({ where: { id: f.job.id } })).status).toBe("LOCAL_PURGED");
    await expect(completeCaseDeletion(f.job.id, admin.id)).rejects.toThrow("DELETION_HOLD_UNRESOLVED");
    await reviewDeletionHold(f.job.id, admin.id, "CLEAR", digest);
    expect((await completeCaseDeletion(f.job.id, admin.id)).status).toBe("COMPLETED");
    // An object-only restore must invalidate even an idempotent completion
    // response. The real isolated restore drill covers replay/reconciliation.
    await storage.uploadBuffer({ storageKey: f.key, buffer: Buffer.from("Restored old object"), mimeType: "text/plain" });
    try { await expect(completeCaseDeletion(f.job.id, admin.id)).rejects.toThrow("RESTORED_OBJECTS_PENDING"); }
    finally { await storage.deleteBuffer(f.key); }
    await expect(prisma.case.create({ data: { id: f.row.id, referenceNumber: f.row.referenceNumber, complainantId: f.owner.id, respondentId: f.respondent.id, state: "CLOSED", closedAt: f.row.closedAt, simulated: true } })).rejects.toThrow("CASE_DELETION_FROZEN");
    await purgeCaseDeletionDatabase(f.job.id, admin.id);
  }, 30000);

  it("requires current party/admin authority, clear holds and a due review; requests are idempotent", async () => {
    const f = await fixture();
    const outsider = await fixture();
    expect((await requestCaseDeletion(f.row.id, f.owner.id)).id).toBe(f.job.id);
    await expect(requestCaseDeletion(f.row.id, outsider.owner.id)).rejects.toThrow("FORBIDDEN");
    await expect(reviewDeletionHold(f.job.id, f.owner.id, "CLEAR", digest)).rejects.toThrow("FORBIDDEN");
    await expect(approveCaseDeletion(f.job.id, admin.id, digest)).rejects.toThrow("DELETION_NOT_APPROVED");
    await reviewDeletionHold(f.job.id, admin.id, "HELD", digest);
    await expect(approveCaseDeletion(f.job.id, admin.id, digest)).rejects.toThrow("DELETION_NOT_APPROVED");
    await reviewDeletionHold(f.job.id, admin.id, "CLEAR", digest);
    await approveCaseDeletion(f.job.id, admin.id, digest);
    await reviewDeletionHold(f.job.id, admin.id, "UNKNOWN", digest);
    expect((await prisma.caseDeletion.findUniqueOrThrow({ where: { id: f.job.id } })).approvedAt).toBeNull();
    await expect(freezeCaseDeletion(f.job.id, admin.id)).rejects.toThrow("DELETION_NOT_APPROVED");
    const recent = await fixture(new Date());
    await reviewDeletionHold(recent.job.id, admin.id, "CLEAR", digest);
    await expect(approveCaseDeletion(recent.job.id, admin.id, digest)).rejects.toThrow("REVIEW_NOT_DUE");
    await expect(prisma.caseDeletionDecision.deleteMany({ where: { deletionId: f.job.id } })).rejects.toThrow("append-only");
  });

  it("blocks unresolved contestations even after the case has closed", async () => {
    const f = await fixture();
    await prisma.contestation.create({ data: { caseId: f.row.id, targetType: "CLAIM", targetId: randomUUID(), grounds: "Synthetic unresolved request", openedById: f.owner.id, status: "RESPONDED", response: "Synthetic response still contested", respondedById: admin.id } });
    await reviewDeletionHold(f.job.id, admin.id, "CLEAR", digest);
    await expect(approveCaseDeletion(f.job.id, admin.id, digest)).rejects.toThrow("ACTIVE_CONTESTATION");
    expect(await storage.downloadBuffer(f.key)).toBeDefined();
  });

  it("never expires an active operation and requires explicit quiescence evidence", async () => {
    const f = await fixture();
    const op = await prisma.caseOperation.create({ data: { caseId: f.row.id, kind: "synthetic interrupted upload", startedAt: new Date("1999-01-01"), storageKeys: [storage.evidenceObjectKey(true, f.row.id, "interrupted-upload")] } });
    await authorizeAndFreeze(f.job.id);
    await expect(inventoryCaseDeletion(f.job.id, admin.id)).rejects.toThrow("OPERATIONS_NOT_DRAINED");
    await expect(resolveCaseOperation(op.id, admin.id, digest, false)).rejects.toThrow("QUIESCENCE_REQUIRED");
    await resolveCaseOperation(op.id, admin.id, digest, true);
    await inventoryCaseDeletion(f.job.id, admin.id);
    expect(await prisma.caseDeletionObject.count({ where: { deletionId: f.job.id } })).toBe(2);
    expect((await prisma.caseOperation.findUniqueOrThrow({ where: { id: op.id } })).resolutionEvidenceDigest).toBe(digest);
    await eraseCaseDeletionObjects(f.job.id, admin.id);
    await purgeCaseDeletionDatabase(f.job.id, admin.id);
    expect(await prisma.caseOperation.count({ where: { caseId: f.row.id } })).toBe(0);
  });

  it("resumes after one object succeeds and the next store operation fails", async () => {
    const f = await fixture();
    await storage.uploadBuffer({ storageKey: storage.evidenceObjectKey(true, f.row.id, "second"), buffer: Buffer.from("Second object"), mimeType: "text/plain" });
    await authorizeAndFreeze(f.job.id);
    await inventoryCaseDeletion(f.job.id, admin.id);
    const original = storage.purgeStoredObject;
    let calls = 0;
    const spy = vi.spyOn(storage, "purgeStoredObject").mockImplementation(async key => {
      if (++calls === 2) throw new Error("SYNTHETIC_STORE_UNAVAILABLE");
      return original(key);
    });
    try { await expect(eraseCaseDeletionObjects(f.job.id, admin.id)).rejects.toThrow("SYNTHETIC_STORE_UNAVAILABLE"); }
    finally { spy.mockRestore(); }
    expect(await prisma.caseDeletionObject.count({ where: { deletionId: f.job.id, erasedAt: { not: null } } })).toBe(1);
    expect(await storage.listStoredKeysForCase(f.row.id, true)).toHaveLength(1);
    await expect(purgeCaseDeletionDatabase(f.job.id, admin.id)).rejects.toThrow();
    expect(await prisma.case.findUnique({ where: { id: f.row.id } })).not.toBeNull();
    await eraseCaseDeletionObjects(f.job.id, admin.id);
    await purgeCaseDeletionDatabase(f.job.id, admin.id);
    expect(await storage.listStoredKeysForCase(f.row.id, true)).toEqual([]);
  });

  it("serializes a new hold behind an in-flight object and stops the next erase", async () => {
    const f = await fixture();
    await storage.uploadBuffer({ storageKey: storage.evidenceObjectKey(true, f.row.id, "second"), buffer: Buffer.from("Second object"), mimeType: "text/plain" });
    await authorizeAndFreeze(f.job.id);
    await inventoryCaseDeletion(f.job.id, admin.id);
    let entered!: () => void;
    let release!: () => void;
    const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
    const releasePromise = new Promise<void>(resolve => { release = resolve; });
    const original = storage.purgeStoredObject;
    const spy = vi.spyOn(storage, "purgeStoredObject").mockImplementationOnce(async key => { entered(); await releasePromise; return original(key); });
    const erasure = eraseCaseDeletionObjects(f.job.id, admin.id).then(() => ({ ok: true as const }), error => ({ ok: false as const, error }));
    await enteredPromise;
    const hold = reviewDeletionHold(f.job.id, admin.id, "HELD", digest);
    // Observe an actual PostgreSQL lock wait; do not infer sequencing from a sleep.
    let waiting = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const rows = await prisma.$queryRaw<Array<{ waiting: boolean }>>`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='transactionid' AND NOT granted) AS waiting`;
      if (rows[0].waiting) { waiting = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    release();
    try {
      expect(waiting).toBe(true);
      await hold;
      const outcome = await erasure;
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error.message).toBe("DELETION_NOT_APPROVED");
      expect(await storage.listStoredKeysForCase(f.row.id, true)).toHaveLength(1);
      expect((await prisma.caseDeletion.findUniqueOrThrow({ where: { id: f.job.id } })).holdState).toBe("HELD");
    } finally { spy.mockRestore(); }
  });

  it("rejects pre-existing cross-case references before destroying any file and prevents new ones after freezing", async () => {
    const f = await fixture();
    const other = await fixture();
    const crossSource = await prisma.source.create({ data: { caseId: other.row.id, kind: "EVIDENCE_ITEM", title: "Corrupt synthetic reference", evidenceItemId: f.evidence.id, createdById: other.owner.id } });
    await reviewDeletionHold(f.job.id, admin.id, "CLEAR", digest);
    await approveCaseDeletion(f.job.id, admin.id, digest);
    await expect(freezeCaseDeletion(f.job.id, admin.id)).rejects.toThrow("CROSS_CASE_REFERENCE");
    expect(await storage.downloadBuffer(f.key)).toBeDefined();
    await prisma.source.delete({ where: { id: crossSource.id } });
    const frozen = await freezeCaseDeletion(f.job.id, admin.id);
    await recordDeletionTombstone(frozen);
    await expect(prisma.source.create({ data: { caseId: other.row.id, kind: "EVIDENCE_ITEM", title: "Late corrupt reference", evidenceItemId: f.evidence.id, createdById: other.owner.id } })).rejects.toThrow("CASE_DELETION_FROZEN");
    await expect(prisma.case.update({ where: { id: f.row.id }, data: { deletionStartedAt: null } })).rejects.toThrow("CASE_DELETION_FROZEN");
  });

  it("refuses a case-owned row that points to another case's storage namespace", async () => {
    const f = await fixture();
    const other = await fixture();
    const otherKey = storage.evidenceObjectKey(true, other.row.id, "unregistered-private-object");
    await storage.uploadBuffer({ storageKey: otherKey, buffer: Buffer.from("Other case file"), mimeType: "text/plain" });
    await prisma.evidenceItem.update({ where: { id: f.evidence.id }, data: { storageKey: otherKey } });
    await authorizeAndFreeze(f.job.id);
    await expect(inventoryCaseDeletion(f.job.id, admin.id)).rejects.toThrow("STORAGE_OWNERSHIP_MISMATCH");
    expect(await storage.downloadBuffer(otherKey)).toEqual(Buffer.from("Other case file"));
  });

  it("checks polymorphic ContextFactor references to both Source and Claim before and after freezing", async () => {
    const f = await fixture();
    const other = await fixture();
    const source = await prisma.source.create({ data: { caseId: f.row.id, kind: "DOCUMENT", title: "Referenced source", createdById: f.owner.id } });
    const claim = await prisma.claim.create({ data: { caseId: f.row.id, claimType: "FACTUAL", text: "Referenced claim", confidenceRationale: "Synthetic unverified claim", createdById: f.owner.id } });
    await reviewDeletionHold(f.job.id, admin.id, "CLEAR", digest);
    await approveCaseDeletion(f.job.id, admin.id, digest);
    const context = (evidenceId: string) => ({ caseId: other.row.id, factorType: "POLICY_VS_PRACTICE" as const, description: "Cross-case synthetic context", gapMap: {}, diagnosis: "NO_GAP_FOUND" as const, evidenceId, createdById: other.owner.id });
    for (const target of [source.id, claim.id]) {
      const corrupt = await prisma.contextFactor.create({ data: context(target) });
      await expect(freezeCaseDeletion(f.job.id, admin.id)).rejects.toThrow("CROSS_CASE_REFERENCE");
      await prisma.contextFactor.delete({ where: { id: corrupt.id } });
    }
    await freezeCaseDeletion(f.job.id, admin.id);
    for (const target of [source.id, claim.id]) await expect(prisma.contextFactor.create({ data: context(target) })).rejects.toThrow("CASE_DELETION_FROZEN");
    expect(await storage.downloadBuffer(f.key)).toBeDefined();
  });

});
