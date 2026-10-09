import { recordStaffAccess } from "../../../../../domain/staffAccess";
import { requireSession } from "../../../../../lib/session";
import { mutationFailureResponse } from "../../../../../domain/mutate";
import { claimInputSchema, readClaimGraph, recordClaim } from "../../../../../domain/claimWrites";

export async function GET(_request: Request, { params }: { params: Promise<{ caseId: string }> }) {
  const auth = await requireSession();
  if ("response" in auth) return auth.response;
  const { caseId } = await params;
  const graph = await readClaimGraph(caseId, auth.session);
  if (!graph) return Response.json({ message: "Not found." }, { status: 404 });
  await recordStaffAccess(caseId, auth.session, "claims");
  return Response.json(
    {
      rendered: graph.view.rendered,
      needsEvidence: graph.view.needsEvidence,
      relationships: graph.view.relationships,
      sources: graph.sources,
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}

export async function POST(request: Request, { params }: { params: Promise<{ caseId: string }> }) {
  const auth = await requireSession();
  if ("response" in auth) return auth.response;
  const { caseId } = await params;
  const parsed = claimInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ message: "A claim needs a type, text, confidence, and locale." }, { status: 400 });
  const outcome = await recordClaim({ ...parsed.data, caseId, actorId: auth.session.userId, actorRole: auth.session.globalRole });
  if (!outcome.ok) return mutationFailureResponse(outcome)!;
  return Response.json({ id: outcome.data.id }, { status: 201, headers: { "Cache-Control": "private, no-store" } });
}
