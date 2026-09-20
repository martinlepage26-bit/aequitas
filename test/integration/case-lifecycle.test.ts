import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../src/lib/prisma";
import {
  createCase,
  openIntake,
  submitCase,
  submitEvidence,
  supersedeEvidence,
  closeIntake,
  submitPosition,
} from "../../src/domain/mutate";

const EICAR = Buffer.from("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*");
const BENIGN = Buffer.from("A genuine evidence document, nothing suspicious here.");

let complainantId: string;
let respondentId: string;
let managerId: string;
let otherManagerId: string;
let statementVersionId: string;

beforeAll(async () => {
  const [consumer, retailer, manager, otherManager, statementVersion] = await Promise.all([
    prisma.user.create({ data: { email: `consumer-${randomUUID()}@example.com`, displayName: "Consumer", globalRole: "COMPLAINANT" } }),
    prisma.user.create({ data: { email: `retailer-${randomUUID()}@example.com`, displayName: "Retailer", globalRole: "RESPONDENT" } }),
    prisma.user.create({ data: { email: `manager-${randomUUID()}@example.com`, displayName: "Manager", globalRole: "CASE_MANAGER" } }),
    prisma.user.create({ data: { email: `manager2-${randomUUID()}@example.com`, displayName: "Other Manager", globalRole: "CASE_MANAGER" } }),
    prisma.consentStatementVersion.create({
      data: { version: Number.parseInt(randomUUID().replaceAll("-", "").slice(0, 8), 16) % 2_000_000_000, locale: "fr-CA", body: "Test.", effectiveFrom: new Date() },
    }),
  ]);
  complainantId = consumer.id;
  respondentId = retailer.id;
  managerId = manager.id;
  otherManagerId = otherManager.id;
  statementVersionId = statementVersion.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function freshOpenCase() {
  const created = await createCase({
    actorId: complainantId,
    actorRole: "COMPLAINANT",
    referenceNumber: `AE-LIFECYCLE-${randomUUID().slice(0, 8)}`,
    complainantId,
    respondentId,
    simulated: true,
    requestedStatementVersionId: statementVersionId,
    currentStatementVersionId: statementVersionId,
  });
  if (!created.ok) throw new Error("setup: createCase failed");
  const submitted = await submitCase({ actorId: complainantId, actorRole: "COMPLAINANT", caseId: created.data.caseId });
  if (!submitted.ok) throw new Error("setup: submitCase failed");
  return created.data.caseId;
}

async function freshEvidenceIntakeCase() {
  const caseId = await freshOpenCase();
  const opened = await openIntake({ actorId: managerId, actorRole: "CASE_MANAGER", caseId, hasConflict: false });
  if (!opened.ok) throw new Error("setup: openIntake failed");
  return caseId;
}

describe("createCase — role enforcement", () => {
  it("rejects a non-COMPLAINANT caller at the authorize-role step, calling createCase() itself (not just runMutation)", async () => {
    const result = await createCase({
      actorId: respondentId,
      actorRole: "RESPONDENT",
      referenceNumber: `AE-LIFECYCLE-${randomUUID().slice(0, 8)}`,
      complainantId,
      respondentId,
      simulated: true,
      requestedStatementVersionId: statementVersionId,
      currentStatementVersionId: statementVersionId,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.step).toBe("authorize-role");
  });
});

describe("submitCase — role and ownership enforcement", () => {
  it("rejects a non-COMPLAINANT caller at the authorize-role step, calling submitCase() itself", async () => {
    const created = await createCase({
      actorId: complainantId,
      actorRole: "COMPLAINANT",
      referenceNumber: `AE-LIFECYCLE-${randomUUID().slice(0, 8)}`,
      complainantId,
      respondentId,
      simulated: true,
      requestedStatementVersionId: statementVersionId,
      currentStatementVersionId: statementVersionId,
    });
    if (!created.ok) throw new Error("setup failed");

    const result = await submitCase({ actorId: respondentId, actorRole: "RESPONDENT", caseId: created.data.caseId });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.step).toBe("authorize-role");
  });

  it("rejects a different consumer (right role, wrong owner) as not-found (Section 16: RBAC failures for non-assigned cases are 404, not 403/409)", async () => {
    const otherConsumer = await prisma.user.create({
      data: { email: `other-consumer-${randomUUID()}@example.com`, displayName: "Other Consumer", globalRole: "COMPLAINANT" },
    });
    const created = await createCase({
      actorId: complainantId,
      actorRole: "COMPLAINANT",
      referenceNumber: `AE-LIFECYCLE-${randomUUID().slice(0, 8)}`,
      complainantId,
      respondentId,
      simulated: true,
      requestedStatementVersionId: statementVersionId,
      currentStatementVersionId: statementVersionId,
    });
    if (!created.ok) throw new Error("setup failed");

    const result = await submitCase({ actorId: otherConsumer.id, actorRole: "COMPLAINANT", caseId: created.data.caseId });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.step).toBe("not-found");
  });
});

describe("openIntake — self-claim, role, and COI enforcement", () => {
  it("rejects a non-CASE_MANAGER caller at the authorize-role step", async () => {
    const caseId = await freshOpenCase();
    const result = await openIntake({ actorId: complainantId, actorRole: "COMPLAINANT", caseId, hasConflict: false });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.step).toBe("authorize-role");
  });

  it("blocks a case manager who declares a conflict of interest", async () => {
    const caseId = await freshOpenCase();
    const result = await openIntake({ actorId: managerId, actorRole: "CASE_MANAGER", caseId, hasConflict: true });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.step).toBe("guard");
    expect(result.reason).toMatch(/conflict of interest/);

    const caseRow = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
    expect(caseRow.caseManagerId).toBeNull();
    expect(caseRow.state).toBe("OPEN");
  });

  it("lets the first case manager to call claim the case (self-claim)", async () => {
    const caseId = await freshOpenCase();
    const result = await openIntake({ actorId: managerId, actorRole: "CASE_MANAGER", caseId, hasConflict: false });
    expect(result.ok).toBe(true);

    const caseRow = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
    expect(caseRow.caseManagerId).toBe(managerId);
    expect(caseRow.state).toBe("EVIDENCE_INTAKE");
  });

  it("blocks a second case manager from claiming an already-assigned case", async () => {
    const caseId = await freshOpenCase();
    const first = await openIntake({ actorId: managerId, actorRole: "CASE_MANAGER", caseId, hasConflict: false });
    expect(first.ok).toBe(true);

    // open_intake's from-state guard already blocks a second call (state is
    // now EVIDENCE_INTAKE, not OPEN) — this proves that boundary too, since
    // it's the mechanism that actually prevents a race in practice.
    const second = await openIntake({ actorId: otherManagerId, actorRole: "CASE_MANAGER", caseId, hasConflict: false });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.step).toBe("authorize-state");
  });
});

// These hit real MinIO and a real ClamAV daemon (docker-compose services),
// not mocks — consistent with this project's testing discipline (see
// DECISIONS.md). fileTypeFromBuffer/MIME sniffing happens one layer up, in
// the HTTP route (src/app/api/cases/[caseId]/evidence/route.ts), so it's
// deliberately not exercised here — submitEvidence/supersedeEvidence take an
// already-resolved mimeType, same as the route passes them.
describe("submitEvidence — role, party, and scan-result enforcement", () => {
  it("rejects a non-party role (CASE_MANAGER) at the authorize-role step", async () => {
    const caseId = await freshEvidenceIntakeCase();
    const result = await submitEvidence({
      actorId: managerId,
      actorRole: "CASE_MANAGER",
      caseId,
      kind: "DOCUMENT",
      title: "Manager trying to submit evidence",
      buffer: BENIGN,
      mimeType: "text/plain",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.step).toBe("authorize-role");
  });

  it("rejects a party role for the wrong case (right role, not this case's party) as not-found", async () => {
    const caseId = await freshEvidenceIntakeCase();
    const otherRetailer = await prisma.user.create({
      data: { email: `other-retailer-${randomUUID()}@example.com`, displayName: "Other Retailer", globalRole: "RESPONDENT" },
    });
    const result = await submitEvidence({
      actorId: otherRetailer.id,
      actorRole: "RESPONDENT",
      caseId,
      kind: "DOCUMENT",
      title: "Not my case",
      buffer: BENIGN,
      mimeType: "text/plain",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.step).toBe("not-found");
  });

  it("stores a clean submission as CLEAN and emits EVIDENCE_SUBMITTED", async () => {
    const caseId = await freshEvidenceIntakeCase();
    const result = await submitEvidence({
      actorId: complainantId,
      actorRole: "COMPLAINANT",
      caseId,
      kind: "PHOTO",
      title: "Photo of the defect",
      buffer: BENIGN,
      mimeType: "image/jpeg",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.eventPayloads[0]).toMatchObject({ type: "EVIDENCE_SUBMITTED" });

    const items = await prisma.evidenceItem.findMany({ where: { caseId } });
    expect(items).toHaveLength(1);
    expect(items[0].scanStatus).toBe("CLEAN");
  });

  it("stores an EICAR-flagged submission as REJECTED and notifies the submitter in their own locale", async () => {
    const caseId = await freshEvidenceIntakeCase();
    const result = await submitEvidence({
      actorId: complainantId,
      actorRole: "COMPLAINANT",
      caseId,
      kind: "DOCUMENT",
      title: "Suspicious file",
      buffer: EICAR,
      mimeType: "text/plain",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const item = await prisma.evidenceItem.findFirstOrThrow({ where: { caseId } });
    expect(item.scanStatus).toBe("REJECTED");

    const consumer = await prisma.user.findUniqueOrThrow({ where: { id: complainantId } });
    const notification = await prisma.notification.findFirstOrThrow({ where: { caseId, kind: "evidence_rejected" } });
    expect(notification.userId).toBe(complainantId);
    expect(notification.locale).toBe(consumer.locale);
  });
});

describe("supersedeEvidence — ownership and versioning enforcement", () => {
  it("rejects a non-party role (CASE_MANAGER) at the authorize-role step", async () => {
    const caseId = await freshEvidenceIntakeCase();
    const submitted = await submitEvidence({
      actorId: complainantId,
      actorRole: "COMPLAINANT",
      caseId,
      kind: "DOCUMENT",
      title: "Original",
      buffer: BENIGN,
      mimeType: "text/plain",
    });
    if (!submitted.ok) throw new Error("setup failed");
    const original = await prisma.evidenceItem.findFirstOrThrow({ where: { caseId } });

    const result = await supersedeEvidence({
      actorId: managerId,
      actorRole: "CASE_MANAGER",
      caseId,
      priorEvidenceItemId: original.id,
      kind: "DOCUMENT",
      title: "Manager trying to supersede",
      buffer: BENIGN,
      mimeType: "text/plain",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.step).toBe("authorize-role");
  });

  it("blocks a party who did not submit the original item (not-found, not a generic guard conflict)", async () => {
    const caseId = await freshEvidenceIntakeCase();
    const submitted = await submitEvidence({
      actorId: complainantId,
      actorRole: "COMPLAINANT",
      caseId,
      kind: "DOCUMENT",
      title: "Original",
      buffer: BENIGN,
      mimeType: "text/plain",
    });
    if (!submitted.ok) throw new Error("setup failed");
    const original = await prisma.evidenceItem.findFirstOrThrow({ where: { caseId } });

    const result = await supersedeEvidence({
      actorId: respondentId,
      actorRole: "RESPONDENT",
      caseId,
      priorEvidenceItemId: original.id,
      kind: "DOCUMENT",
      title: "Hostile takeover attempt",
      buffer: BENIGN,
      mimeType: "text/plain",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.step).toBe("not-found");

    const stillOriginal = await prisma.evidenceItem.findMany({ where: { caseId } });
    expect(stillOriginal).toHaveLength(1);
  });

  it("lets the original submitter supersede their own item, incrementing version and linking supersedesId", async () => {
    const caseId = await freshEvidenceIntakeCase();
    const submitted = await submitEvidence({
      actorId: complainantId,
      actorRole: "COMPLAINANT",
      caseId,
      kind: "DOCUMENT",
      title: "Original",
      buffer: BENIGN,
      mimeType: "text/plain",
    });
    if (!submitted.ok) throw new Error("setup failed");
    const original = await prisma.evidenceItem.findFirstOrThrow({ where: { caseId } });

    const result = await supersedeEvidence({
      actorId: complainantId,
      actorRole: "COMPLAINANT",
      caseId,
      priorEvidenceItemId: original.id,
      kind: "DOCUMENT",
      title: "Clearer version",
      buffer: BENIGN,
      mimeType: "text/plain",
    });
    expect(result.ok).toBe(true);

    const newItem = await prisma.evidenceItem.findFirstOrThrow({ where: { caseId, supersedesId: original.id } });
    expect(newItem.version).toBe(2);
    expect(newItem.title).toBe("Clearer version");
  });
});

describe("closeIntake — manager assignment and evidence-coverage enforcement", () => {
  it("rejects a non-CASE_MANAGER caller at the authorize-role step", async () => {
    const caseId = await freshEvidenceIntakeCase();
    const result = await closeIntake({ actorId: complainantId, actorRole: "COMPLAINANT", caseId });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.step).toBe("authorize-role");
  });

  it("rejects a case manager who is not assigned to this case as not-found", async () => {
    const caseId = await freshEvidenceIntakeCase();
    const result = await closeIntake({ actorId: otherManagerId, actorRole: "CASE_MANAGER", caseId });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.step).toBe("not-found");
  });

  it("blocks closing intake when only one party has submitted evidence, without an override reason", async () => {
    const caseId = await freshEvidenceIntakeCase();
    const submitted = await submitEvidence({
      actorId: complainantId,
      actorRole: "COMPLAINANT",
      caseId,
      kind: "DOCUMENT",
      title: "Only the consumer's evidence",
      buffer: BENIGN,
      mimeType: "text/plain",
    });
    if (!submitted.ok) throw new Error("setup failed");

    const result = await closeIntake({ actorId: managerId, actorRole: "CASE_MANAGER", caseId });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.step).toBe("guard");
    expect(result.reason).toMatch(/Both parties must have/);

    const caseRow = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
    expect(caseRow.state).toBe("EVIDENCE_INTAKE");
  });

  it("allows closing intake with only one party's evidence when an override reason is recorded", async () => {
    const caseId = await freshEvidenceIntakeCase();
    const submitted = await submitEvidence({
      actorId: complainantId,
      actorRole: "COMPLAINANT",
      caseId,
      kind: "DOCUMENT",
      title: "Only the consumer's evidence",
      buffer: BENIGN,
      mimeType: "text/plain",
    });
    if (!submitted.ok) throw new Error("setup failed");

    const result = await closeIntake({
      actorId: managerId,
      actorRole: "CASE_MANAGER",
      caseId,
      overrideReason: "Retailer non-responsive after 10 days.",
    });
    expect(result.ok).toBe(true);

    const caseRow = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
    expect(caseRow.state).toBe("POSITIONS");
  });

  it("closes intake and transitions to POSITIONS once both parties have clean evidence", async () => {
    const caseId = await freshEvidenceIntakeCase();
    const consumerEvidence = await submitEvidence({
      actorId: complainantId,
      actorRole: "COMPLAINANT",
      caseId,
      kind: "DOCUMENT",
      title: "Consumer evidence",
      buffer: BENIGN,
      mimeType: "text/plain",
    });
    const retailerEvidence = await submitEvidence({
      actorId: respondentId,
      actorRole: "RESPONDENT",
      caseId,
      kind: "DOCUMENT",
      title: "Retailer evidence",
      buffer: BENIGN,
      mimeType: "text/plain",
    });
    if (!consumerEvidence.ok || !retailerEvidence.ok) throw new Error("setup failed");

    const result = await closeIntake({ actorId: managerId, actorRole: "CASE_MANAGER", caseId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.eventPayloads[0]).toMatchObject({ type: "EVIDENCE_INTAKE_CLOSED" });

    const caseRow = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
    expect(caseRow.state).toBe("POSITIONS");
  });

  it("ignores REJECTED-only evidence for the per-party coverage check (EICAR-flagged submission does not count)", async () => {
    const caseId = await freshEvidenceIntakeCase();
    const consumerEicar = await submitEvidence({
      actorId: complainantId,
      actorRole: "COMPLAINANT",
      caseId,
      kind: "DOCUMENT",
      title: "Bad file",
      buffer: EICAR,
      mimeType: "text/plain",
    });
    const retailerEvidence = await submitEvidence({
      actorId: respondentId,
      actorRole: "RESPONDENT",
      caseId,
      kind: "DOCUMENT",
      title: "Retailer evidence",
      buffer: BENIGN,
      mimeType: "text/plain",
    });
    if (!consumerEicar.ok || !retailerEvidence.ok) throw new Error("setup failed");

    const result = await closeIntake({ actorId: managerId, actorRole: "CASE_MANAGER", caseId });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.step).toBe("guard");
  });
});

describe("submitPosition — role, party, and versioning enforcement", () => {
  async function freshPositionsCase() {
    const caseId = await freshEvidenceIntakeCase();
    const consumerEvidence = await submitEvidence({
      actorId: complainantId,
      actorRole: "COMPLAINANT",
      caseId,
      kind: "DOCUMENT",
      title: "Consumer evidence",
      buffer: BENIGN,
      mimeType: "text/plain",
    });
    const retailerEvidence = await submitEvidence({
      actorId: respondentId,
      actorRole: "RESPONDENT",
      caseId,
      kind: "DOCUMENT",
      title: "Retailer evidence",
      buffer: BENIGN,
      mimeType: "text/plain",
    });
    if (!consumerEvidence.ok || !retailerEvidence.ok) throw new Error("setup failed");
    const closed = await closeIntake({ actorId: managerId, actorRole: "CASE_MANAGER", caseId });
    if (!closed.ok) throw new Error("setup failed");
    return caseId;
  }

  it("rejects a non-party role (CASE_MANAGER) at the authorize-role step", async () => {
    const caseId = await freshPositionsCase();
    const result = await submitPosition({
      actorId: managerId,
      actorRole: "CASE_MANAGER",
      caseId,
      body: "Manager trying to submit a position",
      locale: "en-CA",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.step).toBe("authorize-role");
  });

  it("rejects a party role for the wrong case (right role, not this case's party) as not-found", async () => {
    const caseId = await freshPositionsCase();
    const otherConsumer = await prisma.user.create({
      data: { email: `other-consumer-position-${randomUUID()}@example.com`, displayName: "Other Consumer", globalRole: "COMPLAINANT" },
    });
    const result = await submitPosition({
      actorId: otherConsumer.id,
      actorRole: "COMPLAINANT",
      caseId,
      body: "Not my case",
      locale: "en-CA",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.step).toBe("not-found");
  });

  it("stores a party's first position statement as version 1 and emits POSITION_SUBMITTED", async () => {
    const caseId = await freshPositionsCase();
    const result = await submitPosition({
      actorId: complainantId,
      actorRole: "COMPLAINANT",
      caseId,
      body: "Here is my position.",
      locale: "fr-CA",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.eventPayloads[0]).toMatchObject({ type: "POSITION_SUBMITTED" });

    const positions = await prisma.positionStatement.findMany({ where: { caseId, partyId: complainantId } });
    expect(positions).toHaveLength(1);
    expect(positions[0].version).toBe(1);
    expect(positions[0].locale).toBe("fr-CA");
  });

  it("increments version on a second submission by the same party, keeping both rows", async () => {
    const caseId = await freshPositionsCase();
    const first = await submitPosition({
      actorId: complainantId,
      actorRole: "COMPLAINANT",
      caseId,
      body: "First draft.",
      locale: "fr-CA",
    });
    if (!first.ok) throw new Error("setup failed");

    const second = await submitPosition({
      actorId: complainantId,
      actorRole: "COMPLAINANT",
      caseId,
      body: "Revised position.",
      locale: "fr-CA",
    });
    expect(second.ok).toBe(true);

    const positions = await prisma.positionStatement.findMany({
      where: { caseId, partyId: complainantId },
      orderBy: { version: "asc" },
    });
    expect(positions).toHaveLength(2);
    expect(positions.map((p) => p.version)).toEqual([1, 2]);
    expect(positions[1].body).toBe("Revised position.");
  });

  it("tracks versions independently per party", async () => {
    const caseId = await freshPositionsCase();
    await submitPosition({ actorId: complainantId, actorRole: "COMPLAINANT", caseId, body: "Consumer position.", locale: "fr-CA" });
    const retailerResult = await submitPosition({
      actorId: respondentId,
      actorRole: "RESPONDENT",
      caseId,
      body: "Retailer position.",
      locale: "en-CA",
    });
    expect(retailerResult.ok).toBe(true);
    if (!retailerResult.ok) return;

    const retailerPositions = await prisma.positionStatement.findMany({ where: { caseId, partyId: respondentId } });
    expect(retailerPositions).toHaveLength(1);
    expect(retailerPositions[0].version).toBe(1);
  });
});
