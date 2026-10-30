import { generateRegistrationOptions, verifyRegistrationResponse } from "@simplewebauthn/server";
import { cookies } from "next/headers";
import { completeAccountRecovery, resolveAccountRecovery } from "../../../../../lib/accountRecovery";
import { createSessionCookie } from "../../../../../lib/session";
import { signPayload, verifyPayload } from "../../../../../lib/signedCookie";
import { CHALLENGE_COOKIE, CHALLENGE_TTL_SECONDS, ORIGIN, RP_ID, RP_NAME } from "../../../../../lib/webauthn";
import { prisma } from "../../../../../lib/prisma";

interface RecoveryChallenge {
  purpose: "account-recovery";
  challenge: string;
  recoveryId: string;
  userId: string;
}

const invalid = () => Response.json({ message: "This recovery link is invalid or has expired." }, { status: 400 });

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  if (!body || (body.step !== "options" && body.step !== "verify")) return Response.json({ message: "Invalid recovery step." }, { status: 400 });
  const recovery = await resolveAccountRecovery(body.token);
  if (!recovery) return invalid();
  const user = await prisma.user.findUnique({ where: { id: recovery.userId }, select: { id: true, email: true, displayName: true, globalRole: true } });
  if (!user) return invalid();

  if (body.step === "options") {
    const options = await generateRegistrationOptions({
      timeout: 60_000,
      rpName: RP_NAME,
      rpID: RP_ID,
      userName: user.email,
      userDisplayName: user.displayName,
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
    });
    const store = await cookies();
    store.set(CHALLENGE_COOKIE, signPayload<RecoveryChallenge>({ purpose: "account-recovery", challenge: options.challenge, recoveryId: recovery.id, userId: user.id }, CHALLENGE_TTL_SECONDS), {
      httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict", path: "/", maxAge: CHALLENGE_TTL_SECONDS,
    });
    return Response.json(options, { headers: { "Cache-Control": "private, no-store" } });
  }

  const store = await cookies();
  const challengeToken = store.get(CHALLENGE_COOKIE)?.value;
  const challenge = challengeToken ? verifyPayload<RecoveryChallenge>(challengeToken) : null;
  if (!challenge || challenge.purpose !== "account-recovery" || challenge.recoveryId !== recovery.id || challenge.userId !== user.id) return invalid();
  let verification;
  try {
    verification = await verifyRegistrationResponse({ response: body.response, expectedChallenge: challenge.challenge, expectedOrigin: ORIGIN, expectedRPID: RP_ID, requireUserVerification: true });
  } catch { return Response.json({ message: "The new passkey could not be verified." }, { status: 400 }); }
  if (!verification.verified || !verification.registrationInfo) return Response.json({ message: "The new passkey could not be verified." }, { status: 400 });
  const { credential } = verification.registrationInfo;
  const recovered = await completeAccountRecovery({ token: body.token, recoveryId: recovery.id, userId: user.id, credential });
  if (!recovered) return invalid();
  store.delete(CHALLENGE_COOKIE);
  await createSessionCookie({ userId: recovered.id, globalRole: recovered.globalRole, authMethod: "passkey" });
  return Response.json({ status: "recovered" }, { headers: { "Cache-Control": "private, no-store" } });
}
