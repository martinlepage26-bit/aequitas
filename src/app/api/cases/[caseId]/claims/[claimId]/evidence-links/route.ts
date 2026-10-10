import { requireSession } from "../../../../../../../lib/session";
import { mutationFailureResponse } from "../../../../../../../domain/mutate";
import { linkClaimEvidence, linkInputSchema } from "../../../../../../../domain/claimWrites";

export async function POST(request: Request, { params }: { params: Promise<{ caseId: string; claimId: string }> }) {
  const auth = await requireSession();
  if ("response" in auth) return auth.response;
  const { caseId, claimId } = await params;
  const parsed = linkInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ message: "A link needs a source, a predicate, and a verbatim excerpt." }, { status: 400 });
  const outcome = await linkClaimEvidence({ ...parsed.data, caseId, claimId, actorId: auth.session.userId, actorRole: auth.session.globalRole });
  if (!outcome.ok) return mutationFailureResponse(outcome)!;
  return Response.json({ id: outcome.data.id }, { status: 201, headers: { "Cache-Control": "private, no-store" } });
}
