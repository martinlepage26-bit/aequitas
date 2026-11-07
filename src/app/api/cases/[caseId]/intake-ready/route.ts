import { requireSession } from "../../../../../lib/session";
import { mutationFailureResponse, setPartyIntakeReady } from "../../../../../domain/mutate";

export async function POST(request: Request, { params }: { params: Promise<{ caseId: string }> }) {
  const auth = await requireSession();
  if ("response" in auth) return auth.response;
  const { caseId } = await params;
  const body = await request.json().catch(() => null);
  if (typeof body?.ready !== "boolean") return Response.json({ message: "ready must be a boolean." }, { status: 400 });

  const result = await setPartyIntakeReady({
    actorId: auth.session.userId,
    actorRole: auth.session.globalRole,
    caseId,
    ready: body.ready,
  });
  if (!result.ok) return mutationFailureResponse(result)!;
  return Response.json({ caseId: result.data.caseId, state: result.data.toState, ready: body.ready }, { headers: { "Cache-Control": "private, no-store" } });
}
