import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../../src/lib/prisma";
import { deliverPendingNotifications, MAX_DELIVERY_ATTEMPTS } from "../../src/lib/mail";

/**
 * The outbox must not let rows that keep failing block newer ones, and must
 * stop retrying a row after a fixed number of attempts. No message leaves
 * this process: fetch is replaced and the provider settings are dummies.
 */

const saved = { ...process.env };
let caseId: string;
let failingUser: string;
let workingUser: string;

beforeAll(async () => {
  Object.assign(process.env, { RESEND_API_KEY: "test-not-a-key", EMAIL_FROM: "noreply@example.org", EMAIL_REPLY_TO: "noreply@example.org", APP_URL: "http://localhost:3000" });
  const mk = async (label: string) => {
    const user = await prisma.user.create({ data: { email: `outbox-${label}-${randomUUID()}@example.org`, displayName: label, globalRole: "COMPLAINANT" } });
    await prisma.webAuthnCredential.create({ data: { userId: user.id, credentialId: randomUUID(), publicKey: Buffer.from("synthetic"), counter: 0n, transports: [] } });
    return user;
  };
  const [failing, working, respondent] = await Promise.all([mk("failing"), mk("working"), mk("respondent")]);
  failingUser = failing.id;
  workingUser = working.id;
  const row = await prisma.case.create({ data: { referenceNumber: `AE-OUTBOX-${randomUUID().slice(0, 8)}`, state: "OPEN", simulated: true, disputeDescription: "Synthetic outbox case.", complainantId: failing.id, respondentId: respondent.id } });
  caseId = row.id;
});

afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  process.env = saved;
  await prisma.$disconnect();
});

describe("notification outbox", () => {
  it("delivers newer rows past a backlog of failures and stops after the attempt limit", async () => {
    await prisma.notification.createMany({ data: Array.from({ length: 25 }, () => ({ userId: failingUser, caseId, kind: "recommendation_issued", locale: "fr-CA" })) });
    await prisma.notification.create({ data: { userId: workingUser, caseId, kind: "recommendation_issued", locale: "en-CA" } });
    const failingEmail = (await prisma.user.findUniqueOrThrow({ where: { id: failingUser } })).email;
    const sent: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { to: string[] };
      if (body.to[0] === failingEmail) return new Response("{}", { status: 500 });
      sent.push(body.to[0]);
      return new Response(JSON.stringify({ id: randomUUID() }), { status: 200 });
    }));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await deliverPendingNotifications(caseId);
    await deliverPendingNotifications(caseId);
    expect(sent).toHaveLength(1);
    expect(await prisma.notification.count({ where: { caseId, userId: workingUser, sentAt: { not: null } } })).toBe(1);

    for (let i = 0; i < MAX_DELIVERY_ATTEMPTS * 2; i += 1) await deliverPendingNotifications(caseId);
    const failing = await prisma.notification.findMany({ where: { caseId, userId: failingUser } });
    expect(failing.every((n) => n.sentAt === null && n.attempts === MAX_DELIVERY_ATTEMPTS)).toBe(true);
    const callsBefore = (fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    await deliverPendingNotifications(caseId);
    expect((fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(callsBefore);
    expect(error.mock.calls.flat().join(" ")).not.toContain(failingEmail);
    error.mockRestore();
  });
});
