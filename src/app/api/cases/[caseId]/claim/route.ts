import { requireSession } from "../../../../../lib/session";
import { claimEscalatedCase } from "../../../../../domain/caseAgent/agent";

// POST /api/cases/[id]/claim — a case manager from the queue takes a case
// the case agent handed back with no one assigned. Body: { hasConflict }.
export async function POST(request: Request, { params }: { params: Promise<{ caseId: string }> }) {
  const auth = await requireSession();
  if ("response" in auth) return auth.response;
  const { caseId } = await params;
  const body = await request.json().catch(() => null);
  if (typeof body?.hasConflict !== "boolean") return Response.json({ message: "hasConflict is required." }, { status: 400 });
  const result = await claimEscalatedCase({ actorId: auth.session.userId, actorRole: auth.session.globalRole, caseId, hasConflict: body.hasConflict });
  if (!result.ok) return Response.json({ message: result.reason }, { status: result.status });
  return Response.json({ caseId, claimed: true }, { headers: { "Cache-Control": "private, no-store" } });
}
