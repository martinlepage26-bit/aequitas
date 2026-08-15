import { requireSession } from "../../../../../lib/session";
import { withdrawCase, mutationFailureResponse } from "../../../../../domain/mutate";

// Section 16: "POST /api/cases/[id]/withdraw — consumer".
export async function POST(request: Request, { params }: { params: Promise<{ caseId: string }> }) {
  const auth = await requireSession();
  if ("response" in auth) return auth.response;
  const { session } = auth;
  const { caseId } = await params;

  const outcome = await withdrawCase({ actorId: session.userId, actorRole: session.globalRole, caseId });
  if (!outcome.ok) return mutationFailureResponse(outcome)!;
  return Response.json({ caseId: outcome.data.caseId, state: outcome.data.toState });
}
