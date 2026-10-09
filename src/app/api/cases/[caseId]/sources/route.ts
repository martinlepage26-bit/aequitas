import { requireSession } from "../../../../../lib/session";
import { mutationFailureResponse } from "../../../../../domain/mutate";
import { recordSource, sourceInputSchema } from "../../../../../domain/claimWrites";

export async function POST(request: Request, { params }: { params: Promise<{ caseId: string }> }) {
  const auth = await requireSession();
  if ("response" in auth) return auth.response;
  const { caseId } = await params;
  const parsed = sourceInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ message: "A source needs a kind and a title." }, { status: 400 });
  const outcome = await recordSource({ ...parsed.data, caseId, actorId: auth.session.userId, actorRole: auth.session.globalRole });
  if (!outcome.ok) return mutationFailureResponse(outcome)!;
  return Response.json({ id: outcome.data.id }, { status: 201, headers: { "Cache-Control": "private, no-store" } });
}
