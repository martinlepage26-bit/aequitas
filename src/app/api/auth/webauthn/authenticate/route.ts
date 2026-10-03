import { generateAuthenticationOptions, verifyAuthenticationResponse } from "@simplewebauthn/server";
import { cookies } from "next/headers";
import { prisma } from "../../../../../lib/prisma";
import { createSessionCookie } from "../../../../../lib/session";
import { signPayload, verifyPayload } from "../../../../../lib/signedCookie";
import { CHALLENGE_COOKIE, CHALLENGE_TTL_SECONDS, ORIGIN, RP_ID } from "../../../../../lib/webauthn";

interface ChallengeCookiePayload {
  purpose: "authenticate";
  challenge: string;
  email: string;
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

    // Discoverable passkeys give identical public options for existing and
    // unknown emails. Resolve the account only after a signed assertion.
    const options = await generateAuthenticationOptions({
      rpID: RP_ID,
      timeout: 60000,
      userVerification: "preferred",
    });

    const token = signPayload<ChallengeCookiePayload>({ purpose: "authenticate", challenge: options.challenge, email: email.trim().toLowerCase() }, CHALLENGE_TTL_SECONDS);
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
    if (!challengePayload || challengePayload.purpose !== "authenticate" || typeof challengePayload.challenge !== "string" || typeof challengePayload.email !== "string") {
      return Response.json({ message: "Authentication ceremony expired or was not started. Try again." }, { status: 400 });
    }

    const credentialId: string | undefined = body.response?.id;
    if (!credentialId) {
      return Response.json({ message: "Malformed authentication response." }, { status: 400 });
    }

    const storedCredential = await prisma.webAuthnCredential.findUnique({ where: { credentialId } });
    if (!storedCredential) {
      return Response.json({ message: "Authentication could not be verified." }, { status: 400 });
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

    const user = await prisma.user.findUniqueOrThrow({ where: { id: storedCredential.userId } });
    if (user.email.trim().toLowerCase() !== challengePayload.email) {
      return Response.json({ message: "Authentication could not be verified." }, { status: 400 });
    }

    await prisma.webAuthnCredential.update({
      where: { id: storedCredential.id },
      data: { counter: BigInt(verification.authenticationInfo.newCounter) },
    });

    store.delete(CHALLENGE_COOKIE);
    await createSessionCookie({ userId: user.id, globalRole: user.globalRole, authMethod: "passkey" });

    return Response.json({ id: user.id, email: user.email, displayName: user.displayName, globalRole: user.globalRole });
  }

  return Response.json({ message: "step must be 'options' or 'verify'." }, { status: 400 });
}
