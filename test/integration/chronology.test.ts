import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../src/lib/prisma";
import { createCase, submitCase, openIntake, closeIntake, submitChronology } from "../../src/domain/mutate";
import { buildExportPdf, buildExportRecord } from "../../src/domain/exportBundle";
import { computeEventHash } from "../../src/domain/events";
import { replayCaseState } from "../../src/domain/replay";
import { ALL_STATES } from "../../src/domain/stateMachine";

let complainantId: string, respondentId: string, managerId: string, outsiderId: string, statementId: string;
beforeAll(async () => {
  const create = (role: "COMPLAINANT" | "RESPONDENT" | "CASE_MANAGER") => prisma.user.create({ data: {
    email: `chronology-test-${randomUUID()}@example.com`, displayName: `Chronology test ${role}`, globalRole: role,
  } });
  const [complainant, respondent, manager, outsider] = await Promise.all([create("COMPLAINANT"), create("RESPONDENT"), create("CASE_MANAGER"), create("COMPLAINANT")]);
  complainantId = complainant.id; respondentId = respondent.id; managerId = manager.id; outsiderId = outsider.id;
  statementId = (await prisma.consentStatementVersion.create({ data: {
    version: Number.parseInt(randomUUID().replaceAll("-", "").slice(0, 8), 16) % 2_000_000_000,
    locale: "fr-CA", body: "Synthetic chronology test consent.", effectiveFrom: new Date(),
  } })).id;
});

async function freshCase() {
  const created = await createCase({ actorId: complainantId, actorRole: "COMPLAINANT", referenceNumber: `AE-CHRONOLOGY-TEST-${randomUUID()}`,
    complainantId, respondentId, disputeDescription: "The other party did not do what we agreed.", simulated: true, requestedStatementVersionId: statementId, currentStatementVersionId: statementId });
  if (!created.ok) throw new Error("Case setup failed");
  const caseId = created.data.caseId;
  if (!(await submitCase({ actorId: complainantId, actorRole: "COMPLAINANT", caseId })).ok) throw new Error("Submit setup failed");
  if (!(await openIntake({ actorId: managerId, actorRole: "CASE_MANAGER", caseId, hasConflict: false })).ok) throw new Error("Open setup failed");
  return caseId;
}
const entry = (caseId: string) => ({ actorId: complainantId, actorRole: "COMPLAINANT" as const, caseId,
  occurredOn: "2026-01-01", title: "Message received", description: "I received a message about the disputed invoice.", locale: "en-CA" });

describe("chronology on isolated PostgreSQL", () => {
  it("persists both parties' reports, calendar ordering and complete audit provenance", async () => {
    const caseId = await freshCase();
    expect((await submitChronology(entry(caseId))).ok).toBe(true);
    expect((await submitChronology({ ...entry(caseId), actorId: respondentId, actorRole: "RESPONDENT", occurredOn: "2025-12-30", description: "I sent the invoice earlier." })).ok).toBe(true);
    const rows = await prisma.chronologyEntry.findMany({ where: { caseId }, orderBy: { occurredOn: "asc" } });
    expect(rows.map(r => r.submittedById)).toEqual([respondentId, complainantId]);
    expect(rows[1].occurredOn.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(rows[1].createdAt.getTime()).toBeGreaterThan(rows[1].occurredOn.getTime());
    const events = await prisma.event.findMany({ where: { caseId }, orderBy: { seq: "asc" } });
    expect(events.slice(-2).map(e => e.type)).toEqual(["CHRONOLOGY_ENTRY_SUBMITTED", "CHRONOLOGY_ENTRY_SUBMITTED"]);
    expect(events.at(-1)?.payload).toMatchObject({ chronologyEntryId: rows[0].id, occurredOn: "2025-12-30", description: "I sent the invoice earlier." });
    for (const event of events) expect(computeEventHash({ prevHash: event.prevHash, payload: event.payload, actorId: event.actorId, seq: event.seq, createdAtIso: event.createdAt.toISOString() })).toBe(event.hash);
    expect(replayCaseState(events)).toBe("EVIDENCE_INTAKE");
  });
  it("rejects managers and outsiders without writing an entry or event", async () => {
    const caseId = await freshCase();
    const count = await prisma.event.count({ where: { caseId } });
    expect(await submitChronology({ ...entry(caseId), actorId: managerId, actorRole: "CASE_MANAGER" })).toMatchObject({ ok: false, step: "authorize-role" });
    expect(await submitChronology({ ...entry(caseId), actorId: outsiderId })).toMatchObject({ ok: false, step: "not-found" });
    expect(await submitChronology({ ...entry(caseId), caseId: randomUUID() })).toMatchObject({ ok: false, step: "not-found" });
    expect(await prisma.chronologyEntry.count({ where: { caseId } })).toBe(0);
    expect(await prisma.event.count({ where: { caseId } })).toBe(count);
  });
  it("rejects invalid calendar dates and every non-intake stage", async () => {
    const caseId = await freshCase();
    expect(await submitChronology({ ...entry(caseId), occurredOn: "2026-02-31" })).toMatchObject({ ok: false, step: "guard" });
    for (const state of ALL_STATES.filter(s => s !== "EVIDENCE_INTAKE")) {
      await prisma.case.update({ where: { id: caseId }, data: { state } });
      expect(await submitChronology(entry(caseId))).toMatchObject({ ok: false, step: "authorize-state" });
    }
    expect(await prisma.chronologyEntry.count({ where: { caseId } })).toBe(0);
  });
  it("serializes concurrent entries and refuses new ones once intake closes", async () => {
    const caseId = await freshCase();
    const results = await Promise.all([submitChronology(entry(caseId)), submitChronology({ ...entry(caseId), title: "A second account" })]);
    expect(results.every(r => r.ok)).toBe(true);
    expect((await closeIntake({ caseId, actorId: managerId, actorRole: "CASE_MANAGER", overrideReason: "Synthetic test without attachments." })).ok).toBe(true);
    expect(await submitChronology(entry(caseId))).toMatchObject({ ok: false, step: "authorize-state" });
    const events = await prisma.event.findMany({ where: { caseId }, orderBy: { seq: "asc" } });
    expect(new Set(events.map(e => e.seq)).size).toBe(events.length);
    expect(replayCaseState(events)).toBe("POSITIONS");
  });
  it("retains original reports at database level and includes them in JSON and PDF exports", async () => {
    const caseId = await freshCase();
    await submitChronology({ ...entry(caseId), title: "Chronologie originale", description: "J'ai reçu le message le premier janvier.", locale: "fr-CA" });
    const row = await prisma.chronologyEntry.findFirstOrThrow({ where: { caseId } });
    await expect(prisma.chronologyEntry.update({ where: { id: row.id }, data: { title: "Overwritten" } })).rejects.toThrow(/append-only/);
    await expect(prisma.chronologyEntry.delete({ where: { id: row.id } })).rejects.toThrow(/append-only/);
    const { record } = await buildExportRecord(caseId);
    expect(record.chronology[0]).toMatchObject({ occurredOn: "2026-01-01", title: "Chronologie originale", submittedById: complainantId });
    const bytes = await buildExportPdf(record);
    expect(bytes.subarray(0, 4).toString()).toBe("%PDF");
    const text = execFileSync("pdftotext", ["-", "-"], { input: bytes, encoding: "utf8" }).replace(/\s+/g, " ");
    expect(text).toContain("Dispute chronology / Chronologie du différend");
    expect(text).toContain("Case activity / Activité du dossier");
    expect(text).toContain("Chronologie originale");
    expect(text).toContain("J'ai reçu le message le premier janvier.");
    expect((await prisma.chronologyEntry.findUniqueOrThrow({ where: { id: row.id } })).title).toBe("Chronologie originale");
  }, 30000);
});
