import { requireSession } from "../../../../../../lib/session";
import { mutationFailureResponse } from "../../../../../../domain/mutate";
import { returnToStage } from "../../../../../../domain/pipeline/writes";

export async function POST(request: Request, { params }: { params: Promise<{ caseId: string }> }) {
  const auth = await requireSession();
  if ("response" in auth) return auth.response;
  const { caseId } = await params;
  const body = await request.json().catch(() => null) as { toStage?: "EPOCHE" | "CLAIM_DECOMPOSITION" | "CONTEXT_MAPPING" | "SYNTHESIS"; reason?: string } | null;
  const outcome = await returnToStage({
    caseId,
    actorId: auth.session.userId,
    actorRole: auth.session.globalRole,
    toStage: body?.toStage ?? "EPOCHE",
    reason: body?.reason ?? "",
  });
  if (!outcome.ok) return mutationFailureResponse(outcome)!;
  return Response.json(outcome.data, { headers: { "Cache-Control": "private, no-store" } });
}
