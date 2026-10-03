import { generateRegistrationOptions, verifyRegistrationResponse } from "@simplewebauthn/server";
import { cookies } from "next/headers";
import { prisma } from "../../../../../lib/prisma";
import { createSessionCookie, getSession } from "../../../../../lib/session";
import { signPayload, verifyPayload } from "../../../../../lib/signedCookie";
import { CHALLENGE_COOKIE, CHALLENGE_TTL_SECONDS, ORIGIN, RP_ID, RP_NAME } from "../../../../../lib/webauthn";
import { authLocale } from "../../../../../lib/authPaths";

// Self-registration creates NEW accounts only, as a complainant or a
// respondent. CASE_MANAGER (the only role that can issue) and ADMIN are
// provisioned through the admin-only invite path (src/app/api/auth/invite)
// or the demo seed — see DECISIONS.md (H1).
const SELF_REGISTERABLE_ROLES = ["COMPLAINANT", "RESPONDENT"] as const;
type SelfRegisterableRole = (typeof SELF_REGISTERABLE_ROLES)[number];

interface ChallengeCookiePayload {
  challenge: string;
  email: string;
  displayName: string;
  globalRole: SelfRegisterableRole;
  locale: string;
  purpose: "register";
}

const EXISTING_ACCOUNT_MESSAGE =
  "An account with this email already exists. Sign in with its passkey, or use the invitation link you were given to claim it.";

/**
 * C1: an email is not proof of identity. A passkey may be attached to an
 * EXISTING account only by a caller already signed in as that same account
 * (adding a second device). Everyone else gets 403 — including for
 * placeholder accounts with no passkey yet, which are claimed only through
 * a single-use invite (src/app/api/auth/invite/claim).
 */
async function existingAccountGate(email: string): Promise<{ existing: { id: string; globalRole: string } | null } | { response: Response }> {
  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true, globalRole: true } });
  if (!existing) return { existing: null };
  const session = await getSession();
  if (!session || session.userId !== existing.id) {
    return { response: Response.json({ message: EXISTING_ACCOUNT_MESSAGE }, { status: 403 }) };
  }
  return { existing };
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body.step !== "string") {
    return Response.json({ message: "step is required." }, { status: 400 });
  }

  if (body.step === "options") {
    const { displayName, globalRole } = body;
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const locale = authLocale(body.locale);
    if (typeof email !== "string" || !email.includes("@")) {
      return Response.json({ message: "A valid email is required." }, { status: 400 });
    }
    if (typeof displayName !== "string" || displayName.trim().length === 0) {
      return Response.json({ message: "displayName is required." }, { status: 400 });
    }

    const gate = await existingAccountGate(email);
    if ("response" in gate) return gate.response;
    // A new account's role comes from the request and must be
    // self-registerable; a signed-in user adding a device keeps their role.
    if (!gate.existing && !SELF_REGISTERABLE_ROLES.includes(globalRole)) {
      return Response.json({ message: `globalRole must be one of ${SELF_REGISTERABLE_ROLES.join(", ")}.` }, { status: 400 });
    }

    const credentials = gate.existing
      ? await prisma.webAuthnCredential.findMany({ where: { userId: gate.existing.id }, select: { credentialId: true, transports: true } })
      : [];

    const options = await generateRegistrationOptions({
      timeout: 60_000,
      rpName: RP_NAME,
      rpID: RP_ID,
      userName: email,
      userDisplayName: displayName,
      excludeCredentials: credentials.map((c) => ({ id: c.credentialId, transports: c.transports as never })),
      authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
    });

    const token = signPayload<ChallengeCookiePayload>(
      { challenge: options.challenge, email, displayName, globalRole, locale, purpose: "register" },
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
    if (!challengePayload || challengePayload.purpose !== "register" || typeof challengePayload.email !== "string" || typeof challengePayload.challenge !== "string") {
      return Response.json({ message: "Registration ceremony expired or was not started. Try again." }, { status: 400 });
    }

    // Re-checked here, not only at the options step: the challenge cookie
    // proves who STARTED a ceremony, not who owns the email now.
    const gate = await existingAccountGate(challengePayload.email);
    if ("response" in gate) return gate.response;
    if (!gate.existing && !SELF_REGISTERABLE_ROLES.includes(challengePayload.globalRole)) {
      return Response.json({ message: `globalRole must be one of ${SELF_REGISTERABLE_ROLES.join(", ")}.` }, { status: 400 });
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
    const existingId = gate.existing?.id ?? null;

    let user;
    try {
      user = await prisma.$transaction(async (tx) => {
        const record = existingId
          ? await tx.user.findUniqueOrThrow({ where: { id: existingId } })
          : await tx.user.create({
              data: {
                email: challengePayload.email,
                displayName: challengePayload.displayName,
                globalRole: challengePayload.globalRole,
                locale: authLocale(challengePayload.locale),
              },
            });

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
    } catch (error) {
      // The email was taken between the gate and the insert (unique
      // violation): same answer as the gate, never an attach.
      if ((error as { code?: string }).code === "P2002") {
        return Response.json({ message: EXISTING_ACCOUNT_MESSAGE }, { status: 403 });
      }
      throw error;
    }

    store.delete(CHALLENGE_COOKIE);
    await createSessionCookie({ userId: user.id, globalRole: user.globalRole, authMethod: "passkey" });

    return Response.json({ id: user.id, email: user.email, displayName: user.displayName, globalRole: user.globalRole });
  }

  return Response.json({ message: "step must be 'options' or 'verify'." }, { status: 400 });
}
