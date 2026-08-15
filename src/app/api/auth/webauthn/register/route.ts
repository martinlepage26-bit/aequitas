import { generateRegistrationOptions, verifyRegistrationResponse } from "@simplewebauthn/server";
import { cookies } from "next/headers";
import { prisma } from "../../../../../lib/prisma";
import { createSessionCookie } from "../../../../../lib/session";
import { signPayload, verifyPayload } from "../../../../../lib/signedCookie";
import { CHALLENGE_COOKIE, CHALLENGE_TTL_SECONDS, ORIGIN, RP_ID, RP_NAME } from "../../../../../lib/webauthn";

// M1 self-registration allows a self-declared role among these three.
// ADMIN provisioning is deliberately excluded from self-service — see
// DECISIONS.md and Appendix B ("real access-control policy... must be
// locked down before real data").
const SELF_REGISTERABLE_ROLES = ["COMPLAINANT", "RESPONDENT", "CASE_MANAGER"] as const;

interface ChallengeCookiePayload {
  challenge: string;
  email: string;
  displayName: string;
  globalRole: (typeof SELF_REGISTERABLE_ROLES)[number];
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body.step !== "string") {
    return Response.json({ message: "step is required." }, { status: 400 });
  }

  if (body.step === "options") {
    const { email, displayName, globalRole } = body;
    if (typeof email !== "string" || !email.includes("@")) {
      return Response.json({ message: "A valid email is required." }, { status: 400 });
    }
    if (typeof displayName !== "string" || displayName.trim().length === 0) {
      return Response.json({ message: "displayName is required." }, { status: 400 });
    }
    if (!SELF_REGISTERABLE_ROLES.includes(globalRole)) {
      return Response.json({ message: `globalRole must be one of ${SELF_REGISTERABLE_ROLES.join(", ")}.` }, { status: 400 });
    }

    const existingUser = await prisma.user.findUnique({ where: { email }, include: { credentials: true } });

    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: RP_ID,
      userName: email,
      userDisplayName: displayName,
      excludeCredentials: existingUser?.credentials.map((c) => ({ id: c.credentialId, transports: c.transports as never })) ?? [],
      authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
    });

    const token = signPayload<ChallengeCookiePayload>(
      { challenge: options.challenge, email, displayName, globalRole },
      CHALLENGE_TTL_SECONDS
    );
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
      return Response.json({ message: "Registration ceremony expired or was not started. Try again." }, { status: 400 });
    }

    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: body.response,
        expectedChallenge: challengePayload.challenge,
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

    const user = await prisma.$transaction(async (tx) => {
      const existing = await tx.user.findUnique({ where: { email: challengePayload.email } });
      const record =
        existing ??
        (await tx.user.create({
          data: {
            email: challengePayload.email,
            displayName: challengePayload.displayName,
            globalRole: challengePayload.globalRole,
          },
        }));

      await tx.webAuthnCredential.create({
        data: {
          userId: record.id,
          credentialId: credential.id,
          publicKey: Buffer.from(credential.publicKey),
          counter: BigInt(credential.counter),
          transports: credential.transports ?? [],
        },
      });

      return record;
    });

    store.delete(CHALLENGE_COOKIE);
    await createSessionCookie({ userId: user.id, globalRole: user.globalRole, authMethod: "passkey" });

    return Response.json({ id: user.id, email: user.email, displayName: user.displayName, globalRole: user.globalRole });
  }

  return Response.json({ message: "step must be 'options' or 'verify'." }, { status: 400 });
}
