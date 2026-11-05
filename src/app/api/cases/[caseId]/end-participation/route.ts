import { requireSession } from "../../../../../lib/session";
import { endParticipation } from "../../../../../domain/caseAgent/agent";

// POST /api/cases/[id]/end-participation — a party leaves the process, as the
// program's rules allow (the complainant always may).
export async function POST(_request: Request, { params }: { params: Promise<{ caseId: string }> }) {
  const auth = await requireSession();
  if ("response" in auth) return auth.response;
  const { caseId } = await params;
  const result = await endParticipation({ actorId: auth.session.userId, actorRole: auth.session.globalRole, caseId });
  if (!result.ok) return Response.json({ message: result.reason }, { status: result.status });
  return Response.json({ caseId, withdrawn: true }, { headers: { "Cache-Control": "private, no-store" } });
}
