import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { downloadCleanEvidence } from "../../src/domain/evidenceAccess";
import { buildExportRecord } from "../../src/domain/exportBundle";
import { createCase, openIntake, submitCase, submitEvidence } from "../../src/domain/mutate";
import { replayCaseState } from "../../src/domain/replay";
import { CASE_AWAITING_MANAGER_KIND } from "../../src/lib/mail";
import { prisma } from "../../src/lib/prisma";
import { evidenceObjectKey, uploadBuffer } from "../../src/lib/storage";

const DESCRIPTION = "The landlord kept the deposit after I moved out. Token DEPOSIT-KEPT-9f3a.";
const EICAR = Buffer.from("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*");
const BENIGN = Buffer.from("A genuine evidence document, nothing suspicious here.");

let complainantId: string;
let respondentId: string;
let activatedManagerId: string;
let inactiveManagerId: string;
let outsiderId: string;
let adminId: string;
let statementVersionId: string;

beforeAll(async () => {
  const stamp = randomUUID();
  const [complainant, respondent, activated, inactive, outsider, admin, statement] = await Promise.all([
    prisma.user.create({ data: { email: `intake-c-${stamp}@example.com`, displayName: "Intake complainant", globalRole: "COMPLAINANT", locale: "fr-CA" } }),
    prisma.user.create({ data: { email: `intake-r-${stamp}@example.com`, displayName: "Intake respondent", globalRole: "RESPONDENT", locale: "fr-CA" } }),
    prisma.user.create({ data: { email: `intake-m-${stamp}@example.com`, displayName: "Activated manager", globalRole: "CASE_MANAGER", locale: "en-CA" } }),
    prisma.user.create({ data: { email: `intake-mi-${stamp}@example.com`, displayName: "Inactive manager", globalRole: "CASE_MANAGER", locale: "fr-CA" } }),
    prisma.user.create({ data: { email: `intake-o-${stamp}@example.com`, displayName: "Outsider", globalRole: "COMPLAINANT", locale: "fr-CA" } }),
    prisma.user.create({ data: { email: `intake-a-${stamp}@example.com`, displayName: "Admin", globalRole: "ADMIN", locale: "fr-CA" } }),
    prisma.consentStatementVersion.create({
      data: { version: Number.parseInt(randomUUID().replaceAll("-", "").slice(0, 8), 16) % 2_000_000_000, locale: "fr-CA", body: "Intake test.", effectiveFrom: new Date() },
    }),
  ]);
  await prisma.webAuthnCredential.create({
    data: { userId: activated.id, credentialId: `cred-${stamp}`, publicKey: Buffer.from("test-key"), counter: 0, transports: [] },
  });
  complainantId = complainant.id;
  respondentId = respondent.id;
  activatedManagerId = activated.id;
  inactiveManagerId = inactive.id;
  outsiderId = outsider.id;
  adminId = admin.id;
  statementVersionId = statement.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

function baseInput(referenceNumber: string) {
  return {
    actorId: complainantId,
    actorRole: "COMPLAINANT" as const,
    referenceNumber,
    complainantId,
    respondentId,
    simulated: true,
    requestedStatementVersionId: statementVersionId,
    currentStatementVersionId: statementVersionId,
  };
}

describe("required intake description", () => {
  it("stores the description and optional amount, and blocks submit when the description is missing", async () => {
    const blank = await createCase({ ...baseInput(`AE-INTAKE-BLANK-${randomUUID().slice(0, 8)}`), disputeDescription: "   " });
    expect(blank).toMatchObject({ ok: false, step: "guard" });

    const created = await createCase({
      ...baseInput(`AE-INTAKE-${randomUUID().slice(0, 8)}`),
      category: "TENANCY",
      disputeDescription: DESCRIPTION,
      amountAtStakeCents: 150050,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const row = await prisma.case.findUniqueOrThrow({ where: { id: created.data.caseId } });
    expect(row.disputeDescription).toBe(DESCRIPTION);
    expect(row.amountAtStakeCents).toBe(150050);
    const { record } = await buildExportRecord(row.id);
    expect(record.case.disputeDescription).toBe(DESCRIPTION);
    expect(record.case.amountAtStakeCents).toBe(150050);

    await prisma.case.update({ where: { id: row.id }, data: { disputeDescription: "   " } });
    const blocked = await submitCase({ actorId: complainantId, actorRole: "COMPLAINANT", caseId: row.id });
    expect(blocked).toMatchObject({ ok: false, step: "guard" });
    expect(blocked.ok ? "" : blocked.reason).toMatch(/disputeDescription/);
    expect(await prisma.notification.count({ where: { caseId: row.id } })).toBe(0);
    expect((await prisma.case.findUniqueOrThrow({ where: { id: row.id } })).state).toBe("DRAFT");
  });
});

describe("case manager notification on submit", () => {
  it("queues a notice for activated case managers and leaves the dispute out of that notice", async () => {
    const created = await createCase({
      ...baseInput(`AE-INTAKE-NOTIFY-${randomUUID().slice(0, 8)}`),
      category: "TENANCY",
      disputeDescription: DESCRIPTION,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const submitted = await submitCase({ actorId: complainantId, actorRole: "COMPLAINANT", caseId: created.data.caseId });
    expect(submitted.ok).toBe(true);

    const notes = await prisma.notification.findMany({
      where: { caseId: created.data.caseId, kind: CASE_AWAITING_MANAGER_KIND },
      include: { user: { include: { credentials: true } } },
    });
    expect(notes.some((note) => note.userId === activatedManagerId && note.locale === "en-CA")).toBe(true);
    expect(notes.some((note) => note.userId === inactiveManagerId)).toBe(false);
    expect(notes.every((note) => note.user.globalRole === "CASE_MANAGER" && note.user.credentials.length > 0)).toBe(true);
    expect(JSON.stringify(notes.map((note) => ({ kind: note.kind, locale: note.locale, userId: note.userId })))).not.toContain("DEPOSIT-KEPT-9f3a");
    const respondentNote = await prisma.notification.findFirst({
      where: { caseId: created.data.caseId, kind: "case_submitted", userId: respondentId },
    });
    expect(respondentNote?.locale).toBe("fr-CA");
  });
});

describe("clean evidence download", () => {
  let caseId: string;
  let cleanId: string;
  let rejectedId: string;

  beforeAll(async () => {
    const created = await createCase({
      ...baseInput(`AE-INTAKE-FILE-${randomUUID().slice(0, 8)}`),
      disputeDescription: DESCRIPTION,
    });
    if (!created.ok) throw new Error("setup: createCase failed");
    caseId = created.data.caseId;
    if (!(await submitCase({ actorId: complainantId, actorRole: "COMPLAINANT", caseId })).ok) throw new Error("setup: submit failed");
    if (!(await openIntake({ actorId: activatedManagerId, actorRole: "CASE_MANAGER", caseId, hasConflict: false })).ok) throw new Error("setup: open failed");
    const clean = await submitEvidence({
      actorId: complainantId,
      actorRole: "COMPLAINANT",
      caseId,
      kind: "DOCUMENT",
      title: "Receipt",
      buffer: BENIGN,
      mimeType: "text/plain",
    });
    if (!clean.ok) throw new Error(`setup: clean evidence failed: ${clean.reason}`);
    const rejected = await submitEvidence({
      actorId: complainantId,
      actorRole: "COMPLAINANT",
      caseId,
      kind: "DOCUMENT",
      title: "Rejected scan",
      buffer: EICAR,
      mimeType: "text/plain",
    });
    if (!rejected.ok) throw new Error(`setup: rejected evidence failed: ${rejected.reason}`);
    cleanId = (await prisma.evidenceItem.findFirstOrThrow({ where: { caseId, scanStatus: "CLEAN" } })).id;
    rejectedId = (await prisma.evidenceItem.findFirstOrThrow({ where: { caseId, scanStatus: "REJECTED" } })).id;
  }, 120_000);

  it("lets a party and the assigned case manager download a clean file", async () => {
    for (const actor of [
      { actorId: complainantId, actorRole: "COMPLAINANT" as const },
      { actorId: respondentId, actorRole: "RESPONDENT" as const },
      { actorId: activatedManagerId, actorRole: "CASE_MANAGER" as const },
    ]) {
      const result = await downloadCleanEvidence({ ...actor, caseId, evidenceId: cleanId });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.body.equals(BENIGN)).toBe(true);
      expect(result.mimeType).toBe("text/plain");
      expect(result.contentDisposition.startsWith("attachment;")).toBe(true);
      expect(result.contentDisposition).not.toMatch(/[\r\n]/);
    }
    const events = await prisma.event.findMany({ where: { caseId, type: "EVIDENCE_ACCESSED" }, orderBy: { seq: "asc" } });
    expect(events).toHaveLength(3);
    expect(events.every((event) => (event.payload as { evidenceItemId?: string }).evidenceItemId === cleanId)).toBe(true);
    expect(replayCaseState(await prisma.event.findMany({ where: { caseId }, orderBy: { seq: "asc" } }))).toBe("EVIDENCE_INTAKE");
  });

  it("hides the file from an outsider and refuses a rejected scan", async () => {
    const before = await prisma.event.count({ where: { caseId, type: "EVIDENCE_ACCESSED" } });
    expect(await downloadCleanEvidence({ actorId: outsiderId, actorRole: "COMPLAINANT", caseId, evidenceId: cleanId })).toEqual({ ok: false, status: 404 });
    const otherManager = await prisma.user.create({
      data: { email: `intake-m2-${randomUUID()}@example.com`, displayName: "Other manager", globalRole: "CASE_MANAGER" },
    });
    expect(await downloadCleanEvidence({ actorId: otherManager.id, actorRole: "CASE_MANAGER", caseId, evidenceId: cleanId })).toEqual({ ok: false, status: 404 });
    expect(await downloadCleanEvidence({ actorId: adminId, actorRole: "ADMIN", caseId, evidenceId: cleanId })).toEqual({ ok: false, status: 404 });
    expect(await downloadCleanEvidence({ actorId: complainantId, actorRole: "COMPLAINANT", caseId, evidenceId: rejectedId })).toEqual({ ok: false, status: 404 });
    expect(await prisma.event.count({ where: { caseId, type: "EVIDENCE_ACCESSED" } })).toBe(before);
  });

  it("refuses a file whose stored hash or storage prefix does not match", async () => {
    const item = await prisma.evidenceItem.findUniqueOrThrow({ where: { id: cleanId } });
    await prisma.evidenceItem.update({ where: { id: cleanId }, data: { sha256: "ab".repeat(32) } });
    expect(await downloadCleanEvidence({ actorId: complainantId, actorRole: "COMPLAINANT", caseId, evidenceId: cleanId })).toEqual({ ok: false, status: 500 });
    await prisma.evidenceItem.update({ where: { id: cleanId }, data: { sha256: item.sha256 } });

    const liveKey = evidenceObjectKey(false, caseId, cleanId);
    await uploadBuffer({ storageKey: liveKey, buffer: Buffer.from("bytes from the other prefix"), mimeType: "text/plain" });
    await prisma.evidenceItem.update({ where: { id: cleanId }, data: { storageKey: liveKey } });
    const refused = await downloadCleanEvidence({ actorId: complainantId, actorRole: "COMPLAINANT", caseId, evidenceId: cleanId });
    expect(refused).toEqual({ ok: false, status: 404 });
    if (refused.ok) expect(refused.body.toString()).not.toContain("other prefix");
    await prisma.evidenceItem.update({ where: { id: cleanId }, data: { storageKey: item.storageKey } });
  });
});
