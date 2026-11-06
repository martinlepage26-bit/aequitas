import { createHash, randomUUID } from "node:crypto";
import { prisma } from "./prisma";
import { issueInviteToken, verifyInviteToken } from "./invite";
import { encryptEmailPayload, invitationEmailPayload } from "./emailPayload";

export const invitationTokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

/** Only tokens registered here can claim accounts; old stateless tokens are invalidated. */
export async function issueStoredInvite(userId: string, locale: string, issuedById?: string, queueEmail = false) {
  const { token, expiresAt } = issueInviteToken(userId);
  const invitation = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
    const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } });
    if (await tx.webAuthnCredential.count({ where: { userId } })) throw new Error("Account already claimed");
    await tx.invitation.updateMany({ where: { userId, revokedAt: null, claimedAt: null }, data: {
      revokedAt: new Date(),
      deliveryPayloadCiphertext: null,
      deliveryPayloadNonce: null,
      deliveryPayloadTag: null,
      deliveryLeaseUntil: null,
    } });
    const id = randomUUID();
    const delivery = queueEmail
      ? encryptEmailPayload("invitation", id, invitationEmailPayload({ email: user.email, locale, claimPath: `/${locale}/invite/${encodeURIComponent(token)}` }))
      : {};
    return tx.invitation.create({ data: { id, userId, tokenHash: invitationTokenHash(token), issuedById, locale, expiresAt, ...delivery } });
  });
  return { token, expiresAt, invitation };
}

export async function resolveInvitation(token: unknown) {
  const userId = verifyInviteToken(token);
  if (!userId || typeof token !== "string") return null;
  const invitation = await prisma.invitation.findUnique({ where: { tokenHash: invitationTokenHash(token) } });
  if (!invitation || invitation.userId !== userId || invitation.revokedAt || invitation.expiresAt <= new Date()) return null;
  return invitation;
}

export async function revokeInvitation(id: string) {
  return prisma.$transaction(async tx => {
    const invitation = await tx.invitation.findUnique({ where: { id } });
    if (!invitation) return false;
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${invitation.userId} FOR UPDATE`;
    const changed = await tx.invitation.updateMany({ where: { id, revokedAt: null, claimedAt: null }, data: {
      revokedAt: new Date(),
      deliveryPayloadCiphertext: null,
      deliveryPayloadNonce: null,
      deliveryPayloadTag: null,
      deliveryLeaseUntil: null,
    } });
    return changed.count === 1;
  });
}
