import { requireSession } from "../../../../../lib/session";
import { requestHumanReview } from "../../../../../domain/caseAgent/agent";

// POST /api/cases/[id]/human-review — either party asks for a person. The
// case agent stops and the assigned case manager takes the case back.
export async function POST(_request: Request, { params }: { params: Promise<{ caseId: string }> }) {
  const auth = await requireSession();
  if ("response" in auth) return auth.response;
  const { caseId } = await params;
  const result = await requestHumanReview({ actorId: auth.session.userId, actorRole: auth.session.globalRole, caseId });
  if (!result.ok) return Response.json({ message: result.reason }, { status: result.status });
  return Response.json({ caseId, escalated: true }, { headers: { "Cache-Control": "private, no-store" } });
}
