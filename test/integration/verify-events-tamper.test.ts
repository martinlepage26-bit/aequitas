import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../src/lib/prisma";
import { createCase } from "../../src/domain/mutate";
import { verifyCase } from "../../src/domain/verifyEvents";

let complainantId: string;
let respondentId: string;
let statementVersionId: string;

beforeAll(async () => {
  const consumer = await prisma.user.create({
    data: { email: `consumer-${randomUUID()}@example.com`, displayName: "Test Consumer", globalRole: "COMPLAINANT" },
  });
  const retailer = await prisma.user.create({
    data: { email: `retailer-${randomUUID()}@example.com`, displayName: "Test Retailer", globalRole: "RESPONDENT" },
  });
  const statementVersion = await prisma.consentStatementVersion.create({
    data: { version: Number.parseInt(randomUUID().replaceAll("-", "").slice(0, 8), 16) % 2_000_000_000, locale: "fr-CA", body: "Test consent statement.", effectiveFrom: new Date() },
  });
  complainantId = consumer.id;
  respondentId = retailer.id;
  statementVersionId = statementVersion.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("verify:events — tamper detection (Section 18 Integrity)", () => {
  it("passes on an untampered case", async () => {
    const result = await createCase({
      actorId: complainantId,
      actorRole: "COMPLAINANT",
      referenceNumber: `AE-TAMPER-OK-${randomUUID().slice(0, 8)}`,
      complainantId,
      respondentId,
      simulated: true,
      requestedStatementVersionId: statementVersionId,
      currentStatementVersionId: statementVersionId,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const caseRow = await prisma.case.findUniqueOrThrow({ where: { id: result.data.caseId } });
    const issues = await verifyCase(prisma, caseRow);
    expect(issues).toEqual([]);
  });

  it("fails after an event row is tampered with — the append-only trigger must be bypassed to even attempt it", async () => {
    const result = await createCase({
      actorId: complainantId,
      actorRole: "COMPLAINANT",
      referenceNumber: `AE-TAMPER-BAD-${randomUUID().slice(0, 8)}`,
      complainantId,
      respondentId,
      simulated: true,
      requestedStatementVersionId: statementVersionId,
      currentStatementVersionId: statementVersionId,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const caseId = result.data.caseId;

    // Guardrail 2 blocks UPDATE at the DB level (proven separately via
    // psql). Simulating "what if that protection were defeated" requires
    // disabling the trigger for this one corruption, same as an attacker
    // with elevated privileges or a tampered restore would need to.
    // The disable, the corruption and the re-enable run in ONE transaction:
    // ALTER TABLE takes an ACCESS EXCLUSIVE lock held until commit, so no
    // other connection can ever observe (or write through) the disabled
    // trigger. Disabling it outside a transaction left the whole Event
    // table unprotected for every connection while this test ran.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`ALTER TABLE "Event" DISABLE TRIGGER events_append_only`);
      const rows = await tx.$executeRawUnsafe(
        `UPDATE "Event" SET payload = '{"tampered":true}'::jsonb WHERE "caseId" = $1 AND seq = 1`,
        caseId
      );
      expect(rows).toBe(1);
      await tx.$executeRawUnsafe(`ALTER TABLE "Event" ENABLE TRIGGER events_append_only`);
    });

    // Protection is back on: further tampering is blocked again.
    await expect(
      prisma.$executeRawUnsafe(`UPDATE "Event" SET payload = '{"still":"blocked"}'::jsonb WHERE "caseId" = $1 AND seq = 1`, caseId)
    ).rejects.toThrow(/append-only/);

    const caseRow = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
    const issues = await verifyCase(prisma, caseRow);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].message).toMatch(/hash mismatch/);
  });
});
