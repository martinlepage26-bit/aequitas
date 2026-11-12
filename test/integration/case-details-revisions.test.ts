import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { afterAll, describe, expect, it, vi } from "vitest";
import { saveCaseDetails } from "../../src/domain/caseDetails";
import { caseDetailsRevisionRecord, digestCaseDetailsRevision, verifyCaseDetailsRevisions } from "../../src/domain/caseDetailsRevision";
import * as events from "../../src/domain/events";
import { buildExportPdf, buildExportRecord, buildPartyExportArchive } from "../../src/domain/exportBundle";
import { verifyCase } from "../../src/domain/verifyEvents";
import { prisma } from "../../src/lib/prisma";
import type { Prisma } from "../../src/generated/prisma";

afterAll(async () => { await prisma.$disconnect(); });

async function fixture() {
  const stamp = randomUUID();
  const owner = await prisma.user.create({ data: { email: `revision-c-${stamp}@example.com`, displayName: "Owner", globalRole: "COMPLAINANT" } });
  const respondent = await prisma.user.create({ data: { email: `revision-r-${stamp}@example.com`, displayName: "Respondent", globalRole: "RESPONDENT" } });
  const row = await prisma.case.create({ data: { referenceNumber: `AE-REV-${stamp}`, state: "DRAFT", category: "RETAIL", disputeDescription: "Original private account", complainantId: owner.id, respondentId: respondent.id } });
  await prisma.$transaction(tx => events.appendEvent(tx, { caseId: row.id, actorId: owner.id, type: "CASE_CREATED", payload: {} }));
  const input = { caseId: row.id, actorId: owner.id, actorRole: "COMPLAINANT" as const, expectedRevision: null as string | null,
    category: "TENANCY", disputeDescription: "Corrected private account", amountAtStake: 40,
    respondentEmail: respondent.email, respondentDisplayName: respondent.displayName, simulated: false };
  return { row, input };
}

describe("event-bound case detail source revisions", () => {
  it("retains historical payloads and exports verifiable new snapshots with existing party visibility", async () => {
    const { row, input } = await fixture();
    const legacy = await prisma.$transaction(tx => events.appendEvent(tx, { caseId: row.id, actorId: input.actorId, type: "CASE_DETAILS_UPDATED", payload: { before: { disputeDescription: "Legacy account" }, after: { disputeDescription: row.disputeDescription } } }));
    const result = await saveCaseDetails({ ...input, expectedRevision: legacy.id });
    expect(result.ok).toBe(true);
    const { record } = await buildExportRecord(row.id);
    expect(await prisma.event.findUnique({ where: { id: legacy.id } })).toEqual(legacy);
    expect(record.caseDetailsRevisions).toHaveLength(1);
    const revision = record.caseDetailsRevisions[0];
    expect(revision).toMatchObject({ caseId: row.id, actorId: input.actorId, before: { disputeDescription: row.disputeDescription }, after: { disputeDescription: input.disputeDescription } });
    const event = record.timeline.find(e => (e.payload as { revisionId?: string }).revisionId === revision.id)!;
    expect(event.payload).toEqual({ revisionId: revision.id, revisionDigest: createHash("sha256").update(events.canonicalJson(revision)).digest("hex") });
    expect(await verifyCase(prisma, row)).toEqual([]);
    const pdf = await buildExportPdf(record);
    const pdfText = execFileSync("pdftotext", ["-", "-"], { input: pdf, encoding: "utf8" }).replace(/\s+/g, " ");
    expect(pdfText).toContain("Original private account");
    expect(pdfText).toContain("Corrected private account");
    const archive = await buildPartyExportArchive(row.id, input.actorId);
    const partyRecord = JSON.parse(execFileSync("python3", ["-c", "import sys,zipfile,io; print(zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())).read('case-record.json').decode())"], { input: archive, encoding: "utf8" }));
    expect(partyRecord.caseDetailsRevisions).toEqual(record.caseDetailsRevisions);
    expect(partyRecord.timeline.some((e: { payload: { revisionId?: string } }) => e.payload.revisionId === revision.id)).toBe(true);
  }, 30000);

  it("excludes orphan source rows and another case's revisions", async () => {
    const first = await fixture();
    const second = await fixture();
    await saveCaseDetails(first.input);
    await saveCaseDetails(second.input);
    const source = await prisma.caseDetailsRevision.findFirstOrThrow({ where: { caseId: first.row.id } });
    const orphan = await prisma.caseDetailsRevision.create({ data: { ...source, id: randomUUID(), before: source.before as Prisma.InputJsonObject, after: { disputeDescription: "Unbound private data" } } });
    const other = await prisma.caseDetailsRevision.findFirstOrThrow({ where: { caseId: second.row.id } });
    const { record } = await buildExportRecord(first.row.id);
    expect(record.caseDetailsRevisions.map(r => r.id)).toEqual([source.id]);
    expect(JSON.stringify(record)).not.toContain(orphan.id);
    expect(JSON.stringify(record)).not.toContain(other.id);
    const event = await prisma.event.findFirstOrThrow({ where: { caseId: first.row.id, type: "CASE_DETAILS_UPDATED" } });
    const foreign = verifyCaseDetailsRevisions([{ ...event, payload: { revisionId: other.id, revisionDigest: digestCaseDetailsRevision(other) } }], [other]);
    expect(foreign.revisions).toEqual([]);
    expect(foreign.issues.join(" ")).toContain("another case or actor");
  });

  it("detects changed or missing snapshots in nightly verification and refuses export", async () => {
    const { row, input } = await fixture();
    await saveCaseDetails(input);
    const source = await prisma.caseDetailsRevision.findFirstOrThrow({ where: { caseId: row.id } });
    try {
      await prisma.caseDetailsRevision.update({ where: { id: source.id }, data: { after: { disputeDescription: "Tampered" } } });
      expect((await verifyCase(prisma, row)).map(i => i.message).join(" ")).toContain("revision digest mismatch");
      await expect(buildExportRecord(row.id)).rejects.toThrow("revision digest mismatch");
      await prisma.caseDetailsRevision.delete({ where: { id: source.id } });
      expect((await verifyCase(prisma, row)).map(i => i.message).join(" ")).toContain("revision is missing");
      await expect(buildExportRecord(row.id)).rejects.toThrow("revision is missing");
    } finally {
      const restored = { ...source, before: source.before as Prisma.InputJsonObject, after: source.after as Prisma.InputJsonObject };
      await prisma.caseDetailsRevision.upsert({ where: { id: source.id }, create: restored, update: restored });
    }
    expect(await verifyCase(prisma, row)).toEqual([]);
    expect((await buildExportRecord(row.id)).record.caseDetailsRevisions).toEqual([caseDetailsRevisionRecord(source)]);
  });

  it("rolls back both snapshots and edits when event insertion fails", async () => {
    const { row, input } = await fixture();
    const append = vi.spyOn(events, "appendEvent").mockRejectedValueOnce(new Error("Synthetic event write failure"));
    try {
      await expect(saveCaseDetails(input)).rejects.toThrow("Synthetic event write failure");
    } finally {
      append.mockRestore();
    }
    expect(await prisma.caseDetailsRevision.count({ where: { caseId: row.id } })).toBe(0);
    expect(await prisma.event.count({ where: { caseId: row.id, type: "CASE_DETAILS_UPDATED" } })).toBe(0);
    expect((await prisma.case.findUniqueOrThrow({ where: { id: row.id } })).disputeDescription).toBe(row.disputeDescription);
  });

  it("serializes concurrent corrections into exactly one revision and event", async () => {
    const { row, input } = await fixture();
    const results = await Promise.all([saveCaseDetails(input), saveCaseDetails({ ...input, disputeDescription: "Concurrent correction" })]);
    expect(results.filter(r => r.ok)).toHaveLength(1);
    expect(results.filter(r => !r.ok && r.status === 409)).toHaveLength(1);
    expect(await prisma.caseDetailsRevision.count({ where: { caseId: row.id } })).toBe(1);
    expect(await prisma.event.count({ where: { caseId: row.id, type: "CASE_DETAILS_UPDATED" } })).toBe(1);
    expect(await verifyCase(prisma, row)).toEqual([]);
  });

  it("exports one consistent snapshot while a correction commits between its reads", async () => {
    const { row, input } = await fixture();
    let signalSnapshot!: () => void;
    let resumeExport!: () => void;
    const snapshotRead = new Promise<void>(resolve => { signalSnapshot = resolve; });
    const resume = new Promise<void>(resolve => { resumeExport = resolve; });
    const transact = prisma.$transaction.bind(prisma);
    // Pause only after the real first database read has established the
    // export snapshot. The correction uses another real connection.
    const transactionSpy = vi.spyOn(prisma, "$transaction").mockImplementationOnce((read, options) =>
      transact(tx => read(new Proxy(tx, {
        get(target, property) {
          if (property !== "case") return Reflect.get(target, property);
          return new Proxy(target.case, {
            get(model, operation) {
              if (operation !== "findUniqueOrThrow") return Reflect.get(model, operation);
              return async (args: Parameters<typeof model.findUniqueOrThrow>[0]) => {
                const value = await model.findUniqueOrThrow(args);
                signalSnapshot();
                await resume;
                return value;
              };
            },
          });
        },
      })), options),
    );
    const exporting = buildExportRecord(row.id);
    try {
      await Promise.race([snapshotRead, exporting.then(() => { throw new Error("Export did not read inside the transaction"); })]);
      expect((await saveCaseDetails(input)).ok).toBe(true);
      await prisma.user.update({ where: { id: input.actorId }, data: { displayName: "Changed during export" } });
      resumeExport();
      const { record } = await exporting;
      expect(record.case.disputeDescription).toBe(row.disputeDescription);
      expect(record.caseDetailsRevisions).toEqual([]);
      expect(record.timeline.map(e => e.type)).toEqual(["CASE_CREATED"]);
      expect(record.timeline[0].actorName).toBe("Owner");
      expect(record.parties.complainant.displayName).toBe("Owner");
      const current = (await buildExportRecord(row.id)).record;
      expect(current.case.disputeDescription).toBe(input.disputeDescription);
      expect(current.caseDetailsRevisions).toHaveLength(1);
      expect(current.timeline.at(-1)?.type).toBe("CASE_DETAILS_UPDATED");
      expect(current.timeline[0].actorName).toBe("Changed during export");
    } finally {
      resumeExport();
      transactionSpy.mockRestore();
      await exporting.catch(() => undefined);
    }
  }, 15000);
});
