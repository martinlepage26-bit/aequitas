import { requireSession } from "../../../../../lib/session";
import { codedFailureResponse, openContestation, openContestationSchema } from "../../../../../domain/resolution";

// Phase 3a: a party or the assigned case manager contests a claim, synthesis,
// proposal, or recommendation on this case.
export async function POST(request: Request, { params }: { params: Promise<{ caseId: string }> }) {
  const auth = await requireSession();
  if ("response" in auth) return auth.response;
  const { caseId } = await params;
  const parsed = openContestationSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ message: "A contestation needs a target and written grounds.", code: "INVALID_INPUT" }, { status: 400 });
  const outcome = await openContestation({ ...parsed.data, caseId, actorId: auth.session.userId, actorRole: auth.session.globalRole });
  if (!outcome.ok) return codedFailureResponse(outcome)!;
  return Response.json({ id: outcome.data.id }, { status: 201, headers: { "Cache-Control": "private, no-store" } });
}
