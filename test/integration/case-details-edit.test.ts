import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { saveCaseDetails } from "../../src/domain/caseDetails";
import { appendEvent } from "../../src/domain/events";
import { prisma } from "../../src/lib/prisma";

let complainantId: string;
let originalId: string;
let caseId: string;
const correctedEmail = `corrected-${randomUUID()}@example.com`;

beforeAll(async () => {
  const stamp = randomUUID();
  const complainant = await prisma.user.create({ data: { email: `edit-c-${stamp}@example.com`, displayName: "Case owner", globalRole: "COMPLAINANT" } });
  const original = await prisma.user.create({ data: { email: `edit-r-${stamp}@example.com`, displayName: "Original respondent", globalRole: "RESPONDENT" } });
  complainantId = complainant.id;
  originalId = original.id;
  const row = await prisma.case.create({ data: { referenceNumber: `AE-EDIT-${stamp}`, state: "DRAFT", category: "RETAIL", disputeDescription: "Initial account", simulated: true, complainantId, respondentId: originalId } });
  caseId = row.id;
  await prisma.$transaction(tx => appendEvent(tx, { caseId, actorId: complainantId, type: "CASE_CREATED", payload: { referenceNumber: row.referenceNumber } }));
});
afterAll(async () => { await prisma.$disconnect(); });

const input = () => ({
  caseId, actorId: complainantId, actorRole: "COMPLAINANT" as const, expectedRevision: null,
  category: "TENANCY", disputeDescription: "Corrected account", amountAtStake: 125.5,
  respondentEmail: correctedEmail, respondentDisplayName: "Corrected respondent", simulated: false,
});

describe("editing initial dossier details", () => {
  it("saves a correction and an audit event without changing the old account", async () => {
    const denied = await saveCaseDetails({ ...input(), actorRole: "CASE_MANAGER" });
    expect(denied).toMatchObject({ ok: false, status: 403 });
    const saved = await saveCaseDetails(input());
    expect(saved).toMatchObject({ ok: true, changed: true });
    if (!saved.ok) return;
    const row = await prisma.case.findUniqueOrThrow({ where: { id: caseId }, include: { respondent: true } });
    expect(row).toMatchObject({ category: "TENANCY", disputeDescription: "Corrected account", amountAtStakeCents: 12550, simulated: false });
    expect(row.respondent.email).toBe(correctedEmail);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: originalId } })).email).not.toBe(correctedEmail);
    const event = await prisma.event.findUniqueOrThrow({ where: { id: saved.revision! } });
    expect(event.type).toBe("CASE_DETAILS_UPDATED");
    expect(event.payload).toMatchObject({ before: { respondentId: originalId }, after: { respondentId: row.respondentId } });
    expect(await saveCaseDetails(input())).toMatchObject({ ok: false, status: 409 });
  });

  it("does not replace an activated respondent", async () => {
    const stamp = randomUUID();
    const activated = await prisma.user.create({ data: { email: `active-r-${stamp}@example.com`, displayName: "Activated respondent", globalRole: "RESPONDENT" } });
    await prisma.webAuthnCredential.create({ data: { userId: activated.id, credentialId: `edit-cred-${stamp}`, publicKey: Buffer.from("test-key"), counter: 0, transports: [] } });
    const row = await prisma.case.create({ data: { referenceNumber: `AE-EDIT-ACTIVE-${stamp}`, state: "OPEN", disputeDescription: "Initial account", complainantId, respondentId: activated.id } });
    const result = await saveCaseDetails({ ...input(), caseId: row.id });
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect((await prisma.case.findUniqueOrThrow({ where: { id: row.id } })).respondentId).toBe(activated.id);
    expect(await prisma.event.count({ where: { caseId: row.id, type: "CASE_DETAILS_UPDATED" } })).toBe(0);
  });

  it("does not change the recipient while an invitation is active", async () => {
    const stamp = randomUUID();
    const respondent = await prisma.user.create({ data: { email: `invited-r-${stamp}@example.com`, displayName: "Invited respondent", globalRole: "RESPONDENT" } });
    const row = await prisma.case.create({ data: { referenceNumber: `AE-EDIT-INVITED-${stamp}`, state: "OPEN", disputeDescription: "Initial account", complainantId, respondentId: respondent.id } });
    await prisma.invitation.create({ data: { userId: respondent.id, tokenHash: stamp.replaceAll("-", ""), locale: "en-CA", expiresAt: new Date(Date.now() + 60_000) } });
    expect(await saveCaseDetails({ ...input(), caseId: row.id })).toMatchObject({ ok: false, status: 409 });
    expect((await prisma.case.findUniqueOrThrow({ where: { id: row.id } })).respondentId).toBe(respondent.id);
  });
});
