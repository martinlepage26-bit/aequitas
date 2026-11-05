import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../src/lib/prisma";
import { claimAgentCase, findEligibleAgentCases, releaseAgentCase } from "../../src/domain/caseAgent/scheduler";

const referencePrefix = `AE-AGENT-SCHEDULE-${randomUUID()}`;
let complainantId: string;
let respondentId: string;
let managerId: string;

beforeAll(async () => {
  const [complainant, respondent, manager] = await Promise.all([
    prisma.user.create({ data: { email: `sched-c-${randomUUID()}@example.org`, displayName: "Scheduler test complainant", globalRole: "COMPLAINANT" } }),
    prisma.user.create({ data: { email: `sched-r-${randomUUID()}@example.org`, displayName: "Scheduler test respondent", globalRole: "RESPONDENT" } }),
    prisma.user.create({ data: { email: `sched-m-${randomUUID()}@example.org`, displayName: "Scheduler test manager", globalRole: "CASE_MANAGER" } }),
  ]);
  complainantId = complainant.id;
  respondentId = respondent.id;
  managerId = manager.id;
});

afterEach(async () => {
  await prisma.case.deleteMany({ where: { referenceNumber: { startsWith: referencePrefix } } });
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: [complainantId, respondentId, managerId].filter(Boolean) } } });
});

async function seedCases(count: number): Promise<string[]> {
  const origin = new Date("2000-01-01T00:00:00.000Z");
  const batchPrefix = `${referencePrefix}-${randomUUID()}`;
  const references = Array.from({ length: count }, (_, index) => `${batchPrefix}-${String(index).padStart(3, "0")}`);
  await prisma.case.createMany({ data: references.map((referenceNumber, index) => ({
    referenceNumber,
    state: "POSITIONS",
    category: "RETAIL",
    disputeDescription: "Synthetic scheduler test case.",
    amountAtStakeCents: 1000,
    simulated: true,
    agentManaged: true,
    complainantId,
    respondentId,
    caseManagerId: managerId,
    createdAt: new Date(origin.getTime() + index * 1000),
  })) });
  const rows = await prisma.case.findMany({ where: { referenceNumber: { in: references } }, orderBy: { createdAt: "asc" }, select: { id: true } });
  return rows.map((row) => row.id);
}

describe("case-agent scheduled work claims", () => {
  it("limits a pass, skips active leases, and revisits older cases fairly", async () => {
    const seededIds = await seedCases(55);
    const now = new Date("2026-11-05T12:00:00.000Z");

    const first = await findEligibleAgentCases({ now });
    expect(first.map((candidate) => candidate.id)).toEqual(seededIds.slice(0, 50));
    const firstLeases = (await Promise.all(first.map((candidate) => claimAgentCase(candidate, now)))).filter((lease) => lease !== null);
    expect(firstLeases).toHaveLength(50);
    await Promise.all(firstLeases.map(releaseAgentCase));

    const next = await findEligibleAgentCases({ now });
    expect(next.map((candidate) => candidate.id)).toEqual(seededIds.slice(50));
    const nextLeases = (await Promise.all(next.map((candidate) => claimAgentCase(candidate, now)))).filter((lease) => lease !== null);
    expect(nextLeases).toHaveLength(5);
    await Promise.all(nextLeases.map(releaseAgentCase));

    expect(await findEligibleAgentCases({ now: new Date(now.getTime() + 9 * 60_000) })).toHaveLength(0);
    const due = await findEligibleAgentCases({ now: new Date(now.getTime() + 10 * 60_000) });
    expect(due.map((candidate) => candidate.id)).toEqual(seededIds.slice(0, 50));
    const retried = (await Promise.all(due.map((candidate) => claimAgentCase(candidate, new Date(now.getTime() + 10 * 60_000))))).filter((lease) => lease !== null);
    expect(retried).toHaveLength(50);
    await Promise.all(retried.map(releaseAgentCase));

    const fairRetry = await findEligibleAgentCases({ now: new Date(now.getTime() + 20 * 60_000) });
    expect(fairRetry.slice(0, 5).map((candidate) => candidate.id)).toEqual(seededIds.slice(50));
  });

  it("allows only one of two concurrent workers to claim a case", async () => {
    await seedCases(1);
    const now = new Date("2026-11-05T13:00:00.000Z");
    const [candidate] = await findEligibleAgentCases({ now, limit: 1 });
    expect(candidate).toBeDefined();
    const claims = await Promise.all([claimAgentCase(candidate, now), claimAgentCase(candidate, now)]);
    const winners = claims.filter((lease) => lease !== null);
    expect(winners).toHaveLength(1);
    const recoveryNow = new Date(now.getTime() + 31 * 60_000);
    const [expiredCandidate] = await findEligibleAgentCases({ now: recoveryNow, limit: 1 });
    expect(expiredCandidate).toBeDefined();
    const replacement = await claimAgentCase(expiredCandidate, recoveryNow);
    expect(replacement).not.toBeNull();
    await releaseAgentCase(winners[0]);
    expect(await findEligibleAgentCases({ now: recoveryNow, limit: 1 })).toHaveLength(0);
    if (replacement) await releaseAgentCase(replacement);
  });
});
