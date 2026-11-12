import { requireSession } from "../../../../../lib/session";
import { enrollCaseAgent } from "../../../../../domain/caseAgent/agent";

// POST /api/cases/[id]/agent — the assigned case manager hands routine steps
// of a retail case to the case agent. There is no HTTP route that runs the
// agent; it runs from the scheduled `npm run agent:run` job.
export async function POST(_request: Request, { params }: { params: Promise<{ caseId: string }> }) {
  const auth = await requireSession();
  if ("response" in auth) return auth.response;
  const { caseId } = await params;
  const result = await enrollCaseAgent({ actorId: auth.session.userId, actorRole: auth.session.globalRole, caseId });
  if (!result.ok) return Response.json({ message: result.reason }, { status: result.status });
  return Response.json({ caseId, agentManaged: true }, { headers: { "Cache-Control": "private, no-store" } });
}
