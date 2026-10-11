import { requireSession } from "../../../../../../lib/session";
import {
  codedFailureResponse,
  overruleContestation,
  respondToContestation,
  withdrawContestation,
} from "../../../../../../domain/resolution";

// Phase 3a: body { action: "respond", text } (assigned case manager),
// { action: "overrule", text } (approver, reason required), or
// { action: "withdraw" } (the person who opened it).
export async function POST(request: Request, { params }: { params: Promise<{ caseId: string; contestationId: string }> }) {
  const auth = await requireSession();
  if ("response" in auth) return auth.response;
  const { caseId, contestationId } = await params;
  const body = await request.json().catch(() => null);
  const action = body?.action;
  const text = typeof body?.text === "string" ? body.text : null;
  const base = { caseId, contestationId, actorId: auth.session.userId, actorRole: auth.session.globalRole };
  let outcome;
  if (action === "respond") outcome = await respondToContestation({ ...base, response: text });
  else if (action === "overrule") outcome = await overruleContestation({ ...base, reason: text });
  else if (action === "withdraw") outcome = await withdrawContestation(base);
  else return Response.json({ message: "action must be one of: respond, overrule, withdraw.", code: "INVALID_INPUT" }, { status: 400 });
  if (!outcome.ok) return codedFailureResponse(outcome)!;
  return Response.json({ id: outcome.data.id }, { headers: { "Cache-Control": "private, no-store" } });
}
