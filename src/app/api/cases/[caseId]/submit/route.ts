import { requireSession } from "../../../../../lib/session";
import { mutationFailureResponse, submitCase } from "../../../../../domain/mutate";

export async function POST(_request: Request, { params }: { params: Promise<{ caseId: string }> }) {
  const auth = await requireSession();
  if ("response" in auth) return auth.response;
  const { session } = auth;
  const { caseId } = await params;

  const outcome = await submitCase({ actorId: session.userId, actorRole: session.globalRole, caseId });
  if (!outcome.ok) return mutationFailureResponse(outcome)!;

  return Response.json({ caseId: outcome.data.caseId, state: outcome.data.toState });
}
