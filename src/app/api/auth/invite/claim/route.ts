import { generateRegistrationOptions, verifyRegistrationResponse } from "@simplewebauthn/server";
import { cookies } from "next/headers";
import { prisma } from "../../../../../lib/prisma";
import { createSessionCookie } from "../../../../../lib/session";
import { signPayload, verifyPayload } from "../../../../../lib/signedCookie";
import { resolveInvitation } from "../../../../../lib/invitations";
import { CHALLENGE_COOKIE, CHALLENGE_TTL_SECONDS, ORIGIN, RP_ID, RP_NAME } from "../../../../../lib/webauthn";

interface ClaimChallengePayload {
  purpose: "invite-claim";
  challenge: string;
  userId: string;
  invitationId: string;
}

const INVALID = () => Response.json({ message: "This invitation link is invalid or has expired." }, { status: 400 });
const ALREADY_CLAIMED = () => Response.json({ message: "This invitation has already been used." }, { status: 409 });

class AlreadyClaimed extends Error {}

/**
 * POST /api/auth/invite/claim — claims a pre-created account with its first
 * passkey, using a single-use invite token (src/lib/invite.ts).
 *   { step: "options", token }            -> WebAuthn creation options
 *   { step: "verify", token, response }   -> attaches the passkey, signs in
 */
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body.step !== "string") {
    return Response.json({ message: "step is required." }, { status: 400 });
  }

  const invitation = await resolveInvitation(body.token);
  if (!invitation) return INVALID();
  const userId = invitation.userId;
  if (invitation.claimedAt) return ALREADY_CLAIMED();

  if (body.step === "options") {
    const user = await prisma.user.findUnique({ where: { id: userId }, include: { _count: { select: { credentials: true } } } });
    if (!user) return INVALID();
    if (user._count.credentials > 0) return ALREADY_CLAIMED();

    const options = await generateRegistrationOptions({
      timeout: 60_000,
      rpName: RP_NAME,
      rpID: RP_ID,
      userName: user.email,
      userDisplayName: user.displayName,
      authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
    });

    const store = await cookies();
    store.set(
      CHALLENGE_COOKIE,
      signPayload<ClaimChallengePayload>({ purpose: "invite-claim", challenge: options.challenge, userId, invitationId: invitation.id }, CHALLENGE_TTL_SECONDS),
      { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict", path: "/", maxAge: CHALLENGE_TTL_SECONDS }
    );
    return Response.json(options);
  }

  if (body.step === "verify") {
    const store = await cookies();
    const cookie = store.get(CHALLENGE_COOKIE)?.value;
    const challenge = cookie ? verifyPayload<ClaimChallengePayload>(cookie) : null;
    if (!challenge || challenge.purpose !== "invite-claim" || challenge.userId !== userId || challenge.invitationId !== invitation.id) {
      return Response.json({ message: "Registration ceremony expired or was not started. Try again." }, { status: 400 });
    }

    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: body.response,
        expectedChallenge: challenge.challenge,
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,
      });
    } catch (error) {
      return Response.json({ message: `Registration could not be verified: ${(error as Error).message}` }, { status: 400 });
    }
    if (!verification.verified || !verification.registrationInfo) {
      return Response.json({ message: "Registration could not be verified." }, { status: 400 });
    }
    const { credential } = verification.registrationInfo;

    let user;
    try {
      user = await prisma.$transaction(async (tx) => {
        // Row lock: two concurrent claims of the same token serialize here,
        // and only the first one finds zero credentials.
        const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
        if (locked.length === 0) throw new AlreadyClaimed();
        const liveInvite = await tx.invitation.findUnique({ where: { id: invitation.id } });
        if (!liveInvite || liveInvite.revokedAt || liveInvite.claimedAt || liveInvite.expiresAt <= new Date()) throw new AlreadyClaimed();
        const count = await tx.webAuthnCredential.count({ where: { userId } });
        if (count > 0) throw new AlreadyClaimed();
        await tx.webAuthnCredential.create({
          data: {
            userId,
            credentialId: credential.id,
            publicKey: Buffer.from(credential.publicKey),
            counter: BigInt(credential.counter),
            transports: credential.transports ?? [],
          },
        });
        await tx.invitation.update({ where: { id: invitation.id }, data: { claimedAt: new Date() } });
        return tx.user.findUniqueOrThrow({ where: { id: userId } });
      });
    } catch (error) {
      if (error instanceof AlreadyClaimed) return ALREADY_CLAIMED();
      throw error;
    }

    store.delete(CHALLENGE_COOKIE);
    await createSessionCookie({ userId: user.id, globalRole: user.globalRole, authMethod: "passkey" });
    return Response.json({ id: user.id, email: user.email, displayName: user.displayName, globalRole: user.globalRole });
  }

  return Response.json({ message: "step must be 'options' or 'verify'." }, { status: 400 });
}
