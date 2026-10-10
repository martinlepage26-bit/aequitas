import { requireSession } from "../../../../../../lib/session";
import { mutationFailureResponse } from "../../../../../../domain/mutate";
import { assembleAndRecordSynthesis } from "../../../../../../domain/pipeline/writes";

export async function POST(_request: Request, { params }: { params: Promise<{ caseId: string }> }) {
  const auth = await requireSession();
  if ("response" in auth) return auth.response;
  const { caseId } = await params;
  const outcome = await assembleAndRecordSynthesis({
    caseId,
    actorId: auth.session.userId,
    actorRole: auth.session.globalRole,
  });
  if (!outcome.ok) return mutationFailureResponse(outcome)!;
  return Response.json({ id: outcome.data.id }, { status: 201, headers: { "Cache-Control": "private, no-store" } });
}
