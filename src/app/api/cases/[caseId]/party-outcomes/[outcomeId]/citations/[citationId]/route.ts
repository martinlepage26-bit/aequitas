import { readPartyOutcomeCitation } from "../../../../../../../../domain/partyOutcomeCitationAccess";
import { requireSession } from "../../../../../../../../lib/session";

export async function GET(_request: Request, { params }: { params: Promise<{ caseId: string; outcomeId: string; citationId: string }> }) {
  const auth = await requireSession();
  if ("response" in auth) return auth.response;
  const { caseId, outcomeId, citationId } = await params;
  const result = await readPartyOutcomeCitation({
    actorId: auth.session.userId,
    actorRole: auth.session.globalRole,
    caseId,
    outcomeId,
    citationId,
  });
  if (!result.ok) {
    return Response.json(
      { message: result.status === 404 ? "Citation not found." : "The source excerpt could not be verified." },
      { status: result.status, headers: { "Cache-Control": "private, no-store" } },
    );
  }
  return Response.json({ excerpt: result.excerpt }, { headers: { "Cache-Control": "private, no-store" } });
}
