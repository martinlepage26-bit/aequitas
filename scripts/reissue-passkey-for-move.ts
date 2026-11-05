import "../src/lib/loadEnv";
import { prisma } from "../src/lib/prisma";
import { issueInviteToken, invitePath } from "../src/lib/invite";
import { invitationTokenHash } from "../src/lib/invitations";

// Operator-assisted re-enrollment after an RP ID change. Run only after the
// account holder's identity has been verified outside Aequitas. The previous
// credentials remain in the pre-cutover backup and on the Railway rollback.
async function main() {
  const [emailArg, attestation] = process.argv.slice(2);
  if (!emailArg || attestation !== "IDENTITY_VERIFIED_FOR_MOVE") {
    throw new Error("Usage: tsx scripts/reissue-passkey-for-move.ts <email> IDENTITY_VERIFIED_FOR_MOVE");
  }
  const email = emailArg.trim().toLowerCase();
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) throw new Error("Account not found.");

  const { token, expiresAt } = issueInviteToken(user.id);
  const count = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${user.id} FOR UPDATE`;
    const removed = await tx.webAuthnCredential.deleteMany({ where: { userId: user.id } });
    if (removed.count === 0) throw new Error("Account has no passkey to re-enroll; use the ordinary invite flow.");
    await tx.invitation.updateMany({
      where: { userId: user.id, revokedAt: null, claimedAt: null },
      data: { revokedAt: new Date() },
    });
    await tx.invitation.create({
      data: { userId: user.id, tokenHash: invitationTokenHash(token), locale: user.locale, expiresAt },
    });
    return removed.count;
  });

  console.error(`Re-enrollment prepared for ${email}; ${count} old credential(s) removed from CT920. Token expires ${expiresAt.toISOString()}.`);
  console.log(new URL(invitePath(user.locale, token), process.env.APP_URL).toString());
}

main()
  .catch((error) => {
    console.error((error as Error).message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
