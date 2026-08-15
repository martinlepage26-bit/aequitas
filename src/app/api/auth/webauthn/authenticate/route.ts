import { generateAuthenticationOptions, verifyAuthenticationResponse } from "@simplewebauthn/server";
import { cookies } from "next/headers";
import { prisma } from "../../../../../lib/prisma";
import { createSessionCookie } from "../../../../../lib/session";
import { signPayload, verifyPayload } from "../../../../../lib/signedCookie";
import { CHALLENGE_COOKIE, CHALLENGE_TTL_SECONDS, ORIGIN, RP_ID } from "../../../../../lib/webauthn";

interface ChallengeCookiePayload {
  challenge: string;
  userId: string;
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body.step !== "string") {
    return Response.json({ message: "step is required." }, { status: 400 });
  }

  if (body.step === "options") {
    const { email } = body;
    if (typeof email !== "string") {
      return Response.json({ message: "email is required." }, { status: 400 });
    }

    // Deliberately not enumeration-hardened yet — a real 404 on unknown
    // email is simpler to debug during M1-M3 and is logged as a known gap
    // in DECISIONS.md rather than silently claimed as production-hardened.
    const user = await prisma.user.findUnique({ where: { email }, include: { credentials: true } });
    if (!user) {
      return Response.json({ message: "No account with that email." }, { status: 404 });
    }

    const options = await generateAuthenticationOptions({
      rpID: RP_ID,
      allowCredentials: user.credentials.map((c) => ({ id: c.credentialId, transports: c.transports as never })),
      userVerification: "preferred",
    });

    const token = signPayload<ChallengeCookiePayload>({ challenge: options.challenge, userId: user.id }, CHALLENGE_TTL_SECONDS);
    const store = await cookies();
    store.set(CHALLENGE_COOKIE, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/",
      maxAge: CHALLENGE_TTL_SECONDS,
    });

    return Response.json(options);
  }

  if (body.step === "verify") {
    const store = await cookies();
    const token = store.get(CHALLENGE_COOKIE)?.value;
    const challengePayload = token ? verifyPayload<ChallengeCookiePayload>(token) : null;
    if (!challengePayload) {
      return Response.json({ message: "Authentication ceremony expired or was not started. Try again." }, { status: 400 });
    }

    const credentialId: string | undefined = body.response?.id;
    if (!credentialId) {
      return Response.json({ message: "Malformed authentication response." }, { status: 400 });
    }

    const storedCredential = await prisma.webAuthnCredential.findUnique({ where: { credentialId } });
    if (!storedCredential || storedCredential.userId !== challengePayload.userId) {
      return Response.json({ message: "This credential does not match the account that started this ceremony." }, { status: 400 });
    }

    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: body.response,
        expectedChallenge: challengePayload.challenge,
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,
        credential: {
          id: storedCredential.credentialId,
          publicKey: new Uint8Array(storedCredential.publicKey),
          counter: Number(storedCredential.counter),
          transports: storedCredential.transports as never,
        },
      });
    } catch (error) {
      return Response.json({ message: `Authentication could not be verified: ${(error as Error).message}` }, { status: 400 });
    }

    if (!verification.verified) {
      return Response.json({ message: "Authentication could not be verified." }, { status: 400 });
    }

    await prisma.webAuthnCredential.update({
      where: { id: storedCredential.id },
      data: { counter: BigInt(verification.authenticationInfo.newCounter) },
    });

    const user = await prisma.user.findUniqueOrThrow({ where: { id: challengePayload.userId } });
    store.delete(CHALLENGE_COOKIE);
    await createSessionCookie({ userId: user.id, globalRole: user.globalRole, authMethod: "passkey" });

    return Response.json({ id: user.id, email: user.email, displayName: user.displayName, globalRole: user.globalRole });
  }

  return Response.json({ message: "step must be 'options' or 'verify'." }, { status: 400 });
}
