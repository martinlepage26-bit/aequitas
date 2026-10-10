import { requireSession } from "../../../../../../../lib/session";
import { mutationFailureResponse } from "../../../../../../../domain/mutate";
import { acknowledgeAssumption, challengeAssumption, reviseAssumption } from "../../../../../../../domain/pipeline/writes";

export async function POST(request: Request, { params }: { params: Promise<{ caseId: string; assumptionId: string }> }) {
  const auth = await requireSession();
  if ("response" in auth) return auth.response;
  const { caseId, assumptionId } = await params;
  const body = await request.json().catch(() => null) as { action?: string; text?: string } | null;
  const actor = { caseId, assumptionId, actorId: auth.session.userId, actorRole: auth.session.globalRole };
  const outcome = body?.action === "challenge"
    ? await challengeAssumption(actor)
    : body?.action === "revise"
      ? await reviseAssumption({ ...actor, text: body.text ?? "" })
      : await acknowledgeAssumption(actor);
  if (!outcome.ok) return mutationFailureResponse(outcome)!;
  return Response.json({ id: outcome.data.id }, { headers: { "Cache-Control": "private, no-store" } });
}
