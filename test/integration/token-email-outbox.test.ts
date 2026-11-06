import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../../src/lib/prisma";
import { issueAccountRecovery } from "../../src/lib/accountRecovery";
import { issueStoredInvite } from "../../src/lib/invitations";
import { deliverPendingTokenEmails, sendAccountRecoveryEmail, sendInvitationEmail } from "../../src/lib/mail";

const saved = { ...process.env };
let invitationUserId: string;
let recoveryUserId: string;
const createdUserIds: string[] = [];

beforeAll(async () => {
  Object.assign(process.env, {
    AEQUITAS_EMAIL_OUTBOX_ENCRYPTION_KEY: "synthetic-email-outbox-key-for-encrypted-outbox-tests",
    RESEND_API_KEY: "test-not-a-key",
    EMAIL_FROM: "noreply@example.org",
    EMAIL_REPLY_TO: "reply@example.org",
    APP_URL: "https://aequitas.example",
  });
  delete process.env.SESSION_SECRET; // Match the least-privilege scheduled worker environment.
  const [invitationUser, recoveryUser] = await Promise.all([
    prisma.user.create({ data: { email: `outbox-invite-${randomUUID()}@example.org`, displayName: "Invite synthetic", globalRole: "RESPONDENT" } }),
    prisma.user.create({ data: { email: `outbox-recovery-${randomUUID()}@example.org`, displayName: "Recovery synthetic", globalRole: "CASE_MANAGER" } }),
  ]);
  invitationUserId = invitationUser.id;
  recoveryUserId = recoveryUser.id;
  createdUserIds.push(invitationUserId, recoveryUserId);
});

afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  process.env = saved;
  if (createdUserIds.length > 0) await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.$disconnect();
});

describe("encrypted invitation and recovery delivery outbox", () => {
  it("retries the same encrypted invitation from the worker without session credentials", async () => {
    const issued = await issueStoredInvite(invitationUserId, "en-CA", undefined, true);
    const initial = await prisma.invitation.findUniqueOrThrow({ where: { id: issued.invitation.id } });
    const recipient = await prisma.user.findUniqueOrThrow({ where: { id: invitationUserId } });
    expect(initial.deliveryPayloadCiphertext).not.toBeNull();
    expect(Buffer.from(initial.deliveryPayloadCiphertext!).includes(Buffer.from(issued.token))).toBe(false);
    expect(Buffer.from(initial.deliveryPayloadCiphertext!).includes(Buffer.from(recipient.email))).toBe(false);

    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      requests.push(String(init.body));
      return new Response("{}", { status: 503 });
    }));
    expect(await sendInvitationEmail({ invitationId: issued.invitation.id })).toBe("pending");
    expect(requests).toHaveLength(2);
    expect(requests[0]).toBe(requests[1]);
    expect(await prisma.invitation.findUniqueOrThrow({ where: { id: issued.invitation.id } })).toMatchObject({ emailedAt: null, deliveryAttempts: 1 });

    await prisma.invitation.update({ where: { id: issued.invitation.id }, data: { deliveryLastAttemptAt: new Date(Date.now() - 16 * 60_000) } });
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      requests.push(String(init.body));
      return Response.json({ id: "synthetic-resend-accepted" });
    }));
    expect(await deliverPendingTokenEmails()).toEqual({ accepted: 1, pending: false });
    expect(requests[2]).toBe(requests[0]);
    const delivered = await prisma.invitation.findUniqueOrThrow({ where: { id: issued.invitation.id } });
    expect(delivered.emailedAt).toBeInstanceOf(Date);
    expect(delivered.deliveryPayloadCiphertext).toBeNull();
    expect(delivered.deliveryPayloadNonce).toBeNull();
    expect(delivered.deliveryPayloadTag).toBeNull();
  });

  it("stores recovery email encrypted and cancels its payload after delivery or definite rejection", async () => {
    const email = (await prisma.user.findUniqueOrThrow({ where: { id: recoveryUserId } })).email;
    const issued = await issueAccountRecovery(email);
    expect(issued).not.toBeNull();
    const recovery = issued!;
    const queued = await prisma.accountRecovery.findUniqueOrThrow({ where: { id: recovery.recovery.id } });
    expect(queued.deliveryPayloadCiphertext).not.toBeNull();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ id: "synthetic-recovery-accepted" })));
    expect(await sendAccountRecoveryEmail({ recoveryId: recovery.recovery.id })).toBe("accepted");
    const delivered = await prisma.accountRecovery.findUniqueOrThrow({ where: { id: recovery.recovery.id } });
    expect(delivered.emailedAt).toBeInstanceOf(Date);
    expect(delivered.deliveryPayloadCiphertext).toBeNull();

    const rejectionUser = await prisma.user.create({ data: { email: `outbox-rejection-${randomUUID()}@example.org`, displayName: "Recovery rejection synthetic", globalRole: "CASE_MANAGER" } });
    createdUserIds.push(rejectionUser.id);
    const second = await issueAccountRecovery(rejectionUser.email);
    expect(second).not.toBeNull();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 422 })));
    expect(await sendAccountRecoveryEmail({ recoveryId: second!.recovery.id })).toBe("rejected");
    const rejected = await prisma.accountRecovery.findUniqueOrThrow({ where: { id: second!.recovery.id } });
    expect(rejected.revokedAt).toBeInstanceOf(Date);
    expect(rejected.deliveryPayloadCiphertext).toBeNull();
  });
});
