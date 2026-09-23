import { prisma } from "../../../lib/prisma";
import { requireSession } from "../../../lib/session";
import { createCase, mutationFailureResponse } from "../../../domain/mutate";
import { DISPUTE_CATEGORIES } from "../../../i18n/categoryGlossary";
import type { DisputeCategory } from "../../../generated/prisma";

function randomReferenceNumber(): string {
  const year = new Date().getFullYear();
  const suffix = Math.floor(Math.random() * 1_000_000)
    .toString()
    .padStart(6, "0");
  return `AE-${year}-${suffix}`;
}

export async function POST(request: Request) {
  const auth = await requireSession();
  if ("response" in auth) return auth.response;
  const { session } = auth;

  if (session.globalRole !== "COMPLAINANT") {
    return Response.json({ message: "Only a complainant may create a case." }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body.respondentEmail !== "string" || typeof body.requestedStatementVersionId !== "string") {
    return Response.json({ message: "respondentEmail and requestedStatementVersionId are required." }, { status: 400 });
  }
  if (body.category !== undefined && !DISPUTE_CATEGORIES.includes(body.category)) {
    return Response.json({ message: `category must be one of: ${DISPUTE_CATEGORIES.join(", ")}` }, { status: 400 });
  }

  // A respondent doesn't need an existing account: a complainant can name
  // anyone by email. If nobody with that email is registered yet, a
  // placeholder RESPONDENT account is created here so the case has
  // somewhere to point; when that person later self-registers with the
  // same email, the real registration flow (webauthn/register's
  // `existing ?? create`) attaches their passkey to this same row instead
  // of erroring or duplicating it. An email that already belongs to a
  // DIFFERENT role is rejected outright — a complainant naming someone
  // else's account as a respondent must never silently repurpose it.
  // No real email is sent (EMAIL_FROM/an email provider was never wired up
  // in this build) — the complainant is responsible for telling the
  // respondent, out of band, to sign in with this exact email.
  const existingRespondent = await prisma.user.findUnique({ where: { email: body.respondentEmail } });
  if (existingRespondent && existingRespondent.globalRole !== "RESPONDENT") {
    return Response.json(
      { message: "That email is already registered under a different role and cannot be used as a respondent." },
      { status: 400 }
    );
  }
  if (!existingRespondent && (typeof body.respondentDisplayName !== "string" || body.respondentDisplayName.trim().length === 0)) {
    return Response.json({ message: "respondentDisplayName is required to invite a new respondent." }, { status: 400 });
  }
  const respondent =
    existingRespondent ??
    (await prisma.user.upsert({
      where: { email: body.respondentEmail },
      update: {},
      create: { email: body.respondentEmail, displayName: body.respondentDisplayName, globalRole: "RESPONDENT" },
    }));

  const complainant = await prisma.user.findUniqueOrThrow({ where: { id: session.userId } });
  const currentStatement = await prisma.consentStatementVersion.findFirst({
    where: { locale: complainant.locale },
    orderBy: { effectiveFrom: "desc" },
  });
  if (!currentStatement) {
    return Response.json({ message: `No consent statement version is configured for locale ${complainant.locale}.` }, { status: 500 });
  }

  const outcome = await createCase({
    actorId: session.userId,
    actorRole: session.globalRole,
    referenceNumber: randomReferenceNumber(),
    complainantId: session.userId,
    respondentId: respondent.id,
    category: body.category as DisputeCategory | undefined,
    simulated: Boolean(body.simulated),
    requestedStatementVersionId: body.requestedStatementVersionId,
    currentStatementVersionId: currentStatement.id,
  });

  if (!outcome.ok) return mutationFailureResponse(outcome)!;

  return Response.json({ caseId: outcome.data.caseId, state: outcome.data.toState });
}
