import { requireSession } from "../../../../../lib/session";
import { closeIntake, mutationFailureResponse } from "../../../../../domain/mutate";

export async function POST(request: Request, { params }: { params: Promise<{ caseId: string }> }) {
  const auth = await requireSession();
  if ("response" in auth) return auth.response;
  const { session } = auth;
  const { caseId } = await params;

  const body = await request.json().catch(() => ({}));
  const overrideReason = typeof body?.overrideReason === "string" && body.overrideReason.trim().length > 0
    ? body.overrideReason
    : undefined;

  const outcome = await closeIntake({ actorId: session.userId, actorRole: session.globalRole, caseId, overrideReason });
  if (!outcome.ok) return mutationFailureResponse(outcome)!;

  return Response.json({ caseId: outcome.data.caseId, state: outcome.data.toState });
}
