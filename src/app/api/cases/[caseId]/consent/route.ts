import { createHash } from "node:crypto";
import { requireSession, getSessionToken } from "../../../../../lib/session";
import { prisma } from "../../../../../lib/prisma";
import { giveConsent, declineConsent, revokeConsent, mutationFailureResponse } from "../../../../../domain/mutate";

// Section 16: "POST /api/cases/[id]/consent — body { action: 'give' | 'decline' | 'revoke' }".
// Replaces an M0-era SQLite prototype route with a different, non-spec
// contract (role/grant/withdraw) at this same path — see DECISIONS.md.
export async function POST(request: Request, { params }: { params: Promise<{ caseId: string }> }) {
  const auth = await requireSession();
  if ("response" in auth) return auth.response;
  const { session } = auth;
  const { caseId } = await params;

  const body = await request.json().catch(() => null);
  const action = body?.action;
  if (action !== "give" && action !== "decline" && action !== "revoke") {
    return Response.json({ message: "action must be one of: give, decline, revoke." }, { status: 400 });
  }

  if (action === "revoke") {
    const outcome = await revokeConsent({ actorId: session.userId, actorRole: session.globalRole, caseId });
    if (!outcome.ok) return mutationFailureResponse(outcome)!;
    return Response.json({ caseId: outcome.data.caseId, state: outcome.data.toState });
  }

  const caseRow = await prisma.case.findUnique({
    where: { id: caseId },
    include: { complainant: { select: { locale: true } }, respondent: { select: { locale: true } } },
  });
  if (!caseRow || !caseRow.currentRecommendationId) {
    return Response.json({ message: "No issued recommendation exists for this case." }, { status: 404 });
  }
  if (typeof body?.statementVersionId !== "string") {
    return Response.json({ message: "statementVersionId is required." }, { status: 400 });
  }

  const actorLocale = session.userId === caseRow.complainantId ? caseRow.complainant.locale : caseRow.respondent.locale;
  const currentStatement = await prisma.consentStatementVersion.findFirst({
    where: { locale: actorLocale },
    orderBy: { effectiveFrom: "desc" },
  });

  // Section 7's authContext: session id, auth method, salted IP hash. No
  // Session table exists (see session.ts) — the signed cookie token itself
  // is what's unique per login, so its hash stands in for a session id.
  const token = await getSessionToken();
  const sessionIdHash = token ? createHash("sha256").update(token).digest("hex") : null;
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? request.headers.get("x-real-ip") ?? null;
  const salt = process.env.IP_HASH_SALT ?? "";
  const ipHash = ip ? createHash("sha256").update(`${salt}:${ip}`).digest("hex") : null;
  const authContext = { sessionIdHash, authMethod: session.authMethod, ipHash };

  const input = {
    actorId: session.userId,
    actorRole: session.globalRole,
    caseId,
    statementVersionId: body.statementVersionId,
    currentStatementVersionId: currentStatement?.id ?? null,
    recommendationId: caseRow.currentRecommendationId,
    authContext,
  };

  const outcome = action === "give" ? await giveConsent(input) : await declineConsent(input);
  if (!outcome.ok) return mutationFailureResponse(outcome)!;
  return Response.json({ caseId: outcome.data.caseId, state: outcome.data.toState });
}
