import { requireSession } from "../../../../../../lib/session";
import { mutationFailureResponse } from "../../../../../../domain/mutate";
import { recordAssumption } from "../../../../../../domain/pipeline/writes";

export async function POST(request: Request, { params }: { params: Promise<{ caseId: string }> }) {
  const auth = await requireSession();
  if ("response" in auth) return auth.response;
  const { caseId } = await params;
  const body = await request.json().catch(() => null) as { text?: string; origin?: "CASE_FRAMING" | "PARTY_STATEMENT" | "ANALYST_NOTE" | "MID_CASE" } | null;
  const outcome = await recordAssumption({
    caseId,
    actorId: auth.session.userId,
    actorRole: auth.session.globalRole,
    text: body?.text ?? "",
    origin: body?.origin ?? "ANALYST_NOTE",
  });
  if (!outcome.ok) return mutationFailureResponse(outcome)!;
  return Response.json({ id: outcome.data.id }, { status: 201, headers: { "Cache-Control": "private, no-store" } });
}
