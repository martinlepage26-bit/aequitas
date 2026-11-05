import { createHash, randomBytes } from "node:crypto";
import { prisma } from "./prisma";

export const RECOVERY_TTL_MINUTES = 30;
const REQUEST_COOLDOWN_MINUTES = 15;

export const recoveryTokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

/** An email address is never returned to the caller as an account-existence signal. */
export async function issueAccountRecovery(email: string) {
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true, email: true, locale: true } });
  if (!user) return null;
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${user.id} FOR UPDATE`;
    const recent = await tx.accountRecovery.findFirst({
      where: { userId: user.id, createdAt: { gt: new Date(Date.now() - REQUEST_COOLDOWN_MINUTES * 60_000) }, revokedAt: null },
      select: { id: true },
    });
    if (recent) return null;
    const token = randomBytes(32).toString("base64url");
    const recovery = await tx.accountRecovery.create({ data: {
      userId: user.id,
      tokenHash: recoveryTokenHash(token),
      expiresAt: new Date(Date.now() + RECOVERY_TTL_MINUTES * 60_000),
    } });
    return { token, recovery, email: user.email, locale: user.locale };
  });
}

export async function revokeAccountRecovery(id: string) {
  await prisma.accountRecovery.updateMany({ where: { id, usedAt: null }, data: { revokedAt: new Date() } });
}

export async function resolveAccountRecovery(token: unknown) {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const recovery = await prisma.accountRecovery.findUnique({ where: { tokenHash: recoveryTokenHash(token) } });
  return recovery && !recovery.usedAt && !recovery.revokedAt && recovery.expiresAt > new Date() ? recovery : null;
}

/** Consume once, rotate the passkey set, and invalidate every existing signed session. */
export async function completeAccountRecovery(input: { token: string; recoveryId: string; userId: string; credential: { id: string; publicKey: Uint8Array; counter: number; transports?: string[] } }) {
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${input.userId} FOR UPDATE`;
    const recovery = await tx.accountRecovery.findUnique({ where: { id: input.recoveryId } });
    if (!recovery || recovery.userId !== input.userId || recovery.tokenHash !== recoveryTokenHash(input.token) || recovery.usedAt || recovery.revokedAt || recovery.expiresAt <= new Date()) return null;
    await tx.webAuthnCredential.deleteMany({ where: { userId: input.userId } });
    await tx.webAuthnCredential.create({ data: {
      userId: input.userId,
      credentialId: input.credential.id,
      publicKey: Buffer.from(input.credential.publicKey),
      counter: BigInt(input.credential.counter),
      transports: input.credential.transports ?? [],
    } });
    const now = new Date();
    await tx.accountRecovery.update({ where: { id: recovery.id }, data: { usedAt: now } });
    await tx.accountRecovery.updateMany({ where: { userId: input.userId, id: { not: recovery.id }, usedAt: null, revokedAt: null }, data: { revokedAt: now } });
    return tx.user.update({ where: { id: input.userId }, data: { sessionVersion: { increment: 1 } } });
  });
}
