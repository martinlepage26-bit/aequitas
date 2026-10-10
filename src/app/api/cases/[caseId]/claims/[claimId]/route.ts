import { requireSession } from "../../../../../../lib/session";
import { mutationFailureResponse } from "../../../../../../domain/mutate";
import { claimPatchSchema, updateClaim } from "../../../../../../domain/claimWrites";

export async function PATCH(request: Request, { params }: { params: Promise<{ caseId: string; claimId: string }> }) {
  const auth = await requireSession();
  if ("response" in auth) return auth.response;
  const { caseId, claimId } = await params;
  const parsed = claimPatchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ message: "The claim update is not valid." }, { status: 400 });
  const outcome = await updateClaim({ ...parsed.data, caseId, claimId, actorId: auth.session.userId, actorRole: auth.session.globalRole });
  if (!outcome.ok) return mutationFailureResponse(outcome)!;
  return Response.json({ id: outcome.data.id }, { headers: { "Cache-Control": "private, no-store" } });
}
