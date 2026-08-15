import { requireSession } from "../../../../../lib/session";
import { mutationFailureResponse, openIntake } from "../../../../../domain/mutate";

export async function POST(request: Request, { params }: { params: Promise<{ caseId: string }> }) {
  const auth = await requireSession();
  if ("response" in auth) return auth.response;
  const { session } = auth;
  const { caseId } = await params;

  const body = await request.json().catch(() => null);
  if (!body || typeof body.hasConflict !== "boolean") {
    return Response.json({ message: "hasConflict (boolean) is required." }, { status: 400 });
  }

  const outcome = await openIntake({
    actorId: session.userId,
    actorRole: session.globalRole,
    caseId,
    hasConflict: body.hasConflict,
    coiDetails: typeof body.coiDetails === "string" ? body.coiDetails : undefined,
  });
  if (!outcome.ok) return mutationFailureResponse(outcome)!;

  return Response.json({ caseId: outcome.data.caseId, state: outcome.data.toState });
}
