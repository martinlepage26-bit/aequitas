import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../src/lib/prisma";
import { createCase, runMutation } from "../../src/domain/mutate";
import { NONE } from "../../src/domain/stateMachine";

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
    // version has no test-scoped uniqueness lever (it is a real business
    // field, @@unique([version, locale])); use a UUID-derived integer so
    // parallel or repeated local runs do not collide.
    data: { version: Number.parseInt(randomUUID().replaceAll("-", "").slice(0, 8), 16) % 2_000_000_000, locale: "fr-CA", body: "Test consent statement.", effectiveFrom: new Date() },
  });
  complainantId = consumer.id;
  respondentId = retailer.id;
  statementVersionId = statementVersion.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("mutation pipeline: createCase", () => {
  it("writes the Case row and its CASE_CREATED event atomically", async () => {
    const referenceNumber = `AE-TEST-${randomUUID().slice(0, 8)}`;
    const result = await createCase({
      actorId: complainantId,
      actorRole: "COMPLAINANT",
      referenceNumber,
      complainantId,
      respondentId,
      simulated: true,
      disputeDescription: "The other party did not do what we agreed.",
      requestedStatementVersionId: statementVersionId,
      currentStatementVersionId: statementVersionId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const caseRow = await prisma.case.findUnique({ where: { id: result.data.caseId } });
    expect(caseRow?.state).toBe("DRAFT");
    expect(caseRow?.referenceNumber).toBe(referenceNumber);

    const events = await prisma.event.findMany({ where: { caseId: result.data.caseId }, orderBy: { seq: "asc" } });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("CASE_CREATED");
    expect(events[0].seq).toBe(1);
    expect(events[0].prevHash).toMatch(/^0{64}$/);
  });

  it("rejects an unauthenticated actor before touching the transaction", async () => {
    const result = await createCase({
      actorId: complainantId,
      actorRole: "COMPLAINANT",
      referenceNumber: `AE-TEST-${randomUUID().slice(0, 8)}`,
      complainantId,
      respondentId,
      simulated: true,
      disputeDescription: "The other party did not do what we agreed.",
      requestedStatementVersionId: "stale-version-id",
      currentStatementVersionId: statementVersionId,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.step).toBe("guard");
  });

  it("rejects a role other than COMPLAINANT (authorize-role step, before any guard runs)", async () => {
    const result = await runMutation({
      trigger: "create_case",
      actorId: respondentId,
      actorRole: "RESPONDENT",
      fromState: NONE,
      guardContexts: {},
      write: async () => {
        throw new Error("write() must never run when authorization fails");
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.step).toBe("authorize-role");
  });

  it("rolls back the domain write when the transaction throws after it", async () => {
    const referenceNumber = `AE-TEST-${randomUUID().slice(0, 8)}`;

    await expect(
      runMutation({
        trigger: "create_case",
        actorId: complainantId,
        actorRole: "COMPLAINANT",
        fromState: NONE,
        guardContexts: {
          authenticated: { actorId: complainantId },
          statementVersionsCurrent: { requestedVersionId: statementVersionId, currentVersionId: statementVersionId },
        },
        write: async (tx) => {
          await tx.case.create({
            data: {
              referenceNumber,
              state: "DRAFT",
              simulated: true,
              complainantId,
              respondentId,
            },
          });
          throw new Error("simulated failure after the domain write");
        },
      })
    ).rejects.toThrow("simulated failure after the domain write");

    const caseRow = await prisma.case.findUnique({ where: { referenceNumber } });
    expect(caseRow).toBeNull();
  });
});
