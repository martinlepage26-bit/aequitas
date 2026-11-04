import { requireSession } from "../../../../../lib/session";
import { authorDraft } from "../../../../../domain/authoredDraft";
import { mutationFailureResponse } from "../../../../../domain/mutate";

// POST /api/cases/[id]/authored-draft — assigned case manager only.
// Writes a recommendation draft by hand. No model or legal-research
// provider is called. Issuance remains the separate checklist route.
export async function POST(request: Request, { params }: { params: Promise<{ caseId: string }> }) {
  const auth = await requireSession();
  if ("response" in auth) return auth.response;
  const { caseId } = await params;
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return Response.json({ message: "A draft is required." }, { status: 400 });
  }
  const result = await authorDraft({
    actorId: auth.session.userId,
    actorRole: auth.session.globalRole,
    caseId,
    fields: body.explanation,
    reason: typeof body.reason === "string" ? body.reason : undefined,
    replacesRecommendationId: typeof body.replacesRecommendationId === "string" ? body.replacesRecommendationId : null,
  });
  if (!result.ok) return mutationFailureResponse(result)!;
  return Response.json({ caseId, state: result.data.toState }, { headers: { "Cache-Control": "private, no-store" } });
}
