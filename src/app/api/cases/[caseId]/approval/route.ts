import { requireSession } from "../../../../../lib/session";
import { approveResolution, codedFailureResponse } from "../../../../../domain/resolution";

// Phase 3b: approver sign-off on the current issued recommendation.
// 403 ADMIN_CANNOT_APPROVE / NOT_APPROVER / PARTY_CANNOT_APPROVE;
// 409 SAME_AUTHOR / MISSING_RATIONALE / OPEN_CONTESTATION / NO_ISSUED_RECOMMENDATION / ALREADY_APPROVED.
export async function POST(request: Request, { params }: { params: Promise<{ caseId: string }> }) {
  const auth = await requireSession();
  if ("response" in auth) return auth.response;
  const { caseId } = await params;
  const body = await request.json().catch(() => null);
  const rationale = typeof body?.rationale === "string" ? body.rationale : null;
  const outcome = await approveResolution({ caseId, rationale, actorId: auth.session.userId, actorRole: auth.session.globalRole });
  if (!outcome.ok) return codedFailureResponse(outcome)!;
  return Response.json({ id: outcome.data.id }, { status: 201, headers: { "Cache-Control": "private, no-store" } });
}
