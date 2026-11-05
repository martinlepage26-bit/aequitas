import { requireSession } from "../../../../../lib/session";
import { issuePartyOutcome, savePartyOutcomeDraft } from "../../../../../domain/partyOutcome";
import { codedFailureResponse } from "../../../../../domain/resolution";

export async function POST(request: Request, { params }: { params: Promise<{ caseId: string }> }) {
  const auth = await requireSession();
  if ("response" in auth) return auth.response;
  const { session } = auth;
  const { caseId } = await params;

  const body = await request.json().catch(() => null);
  const action = body?.action;
  if (action !== "save" && action !== "issue") {
    return Response.json({ message: "action must be one of: save, issue." }, { status: 400 });
  }
  if (typeof body?.partyId !== "string" || typeof body?.body !== "string") {
    return Response.json({ message: "partyId and body are required." }, { status: 400 });
  }

  const input = {
    actorId: session.userId,
    actorRole: session.globalRole,
    caseId,
    partyId: body.partyId,
    body: body.body,
    locale: typeof body.locale === "string" ? body.locale : undefined,
  };
  const outcome = action === "save" ? await savePartyOutcomeDraft(input) : await issuePartyOutcome(input);
  if (!outcome.ok) return codedFailureResponse(outcome)!;
  return Response.json(outcome.data);
}
