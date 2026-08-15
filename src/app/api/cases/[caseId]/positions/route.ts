import { requireSession } from "../../../../../lib/session";
import { submitPosition, mutationFailureResponse } from "../../../../../domain/mutate";
import { prisma } from "../../../../../lib/prisma";

export async function POST(request: Request, { params }: { params: Promise<{ caseId: string }> }) {
  const auth = await requireSession();
  if ("response" in auth) return auth.response;
  const { session } = auth;
  const { caseId } = await params;

  const body = await request.json().catch(() => ({}));
  const positionBody = typeof body?.body === "string" ? body.body.trim() : "";
  if (positionBody.length === 0) {
    return Response.json({ message: "body is required." }, { status: 400 });
  }
  let locale = typeof body?.locale === "string" && body.locale.trim().length > 0 ? body.locale : undefined;
  if (!locale) {
    const actor = await prisma.user.findUnique({ where: { id: session.userId }, select: { locale: true } });
    locale = actor?.locale ?? "fr-CA";
  }

  const outcome = await submitPosition({
    actorId: session.userId,
    actorRole: session.globalRole,
    caseId,
    body: positionBody,
    locale,
  });
  if (!outcome.ok) return mutationFailureResponse(outcome)!;

  return Response.json({ caseId: outcome.data.caseId, state: outcome.data.toState });
}
