import { requireSession } from "../../../../../lib/session";
import { prisma } from "../../../../../lib/prisma";
import { completeDraft, mutationFailureResponse, requestDraft, requestNewVersion } from "../../../../../domain/mutate";

// Section 16: "POST /api/cases/[id]/draft-requests — case manager".
// Section 9's pipeline chains "system assembles a prompt... -> Claude
// returns a structured draft -> validated -> stored as DRAFT" directly
// after the case manager's request — this build has no background job
// queue, so both mutations run synchronously in this one request. See
// DECISIONS.md's M3 note.
//
// Also handles Section 6 row 14 (request_new_version): Section 16 names no
// separate endpoint for a redraft after a decline/revocation, and to the
// case manager it's the same UI action ("request a draft") just fired from
// a different case state — so this route picks request_draft vs.
// request_new_version based on the case's current state rather than
// inventing unspecified API surface. See DECISIONS.md.
export async function POST(request: Request, { params }: { params: Promise<{ caseId: string }> }) {
  const auth = await requireSession();
  if ("response" in auth) return auth.response;
  const { session } = auth;
  const { caseId } = await params;

  const caseRow = await prisma.case.findUnique({ where: { id: caseId } });
  if (!caseRow) return Response.json({ message: "Case not found." }, { status: 404 });

  const requested =
    caseRow.state === "RESOLVED_DECLINED" || caseRow.state === "ISSUED"
      ? await requestNewVersion({ actorId: session.userId, actorRole: session.globalRole, caseId })
      : await requestDraft({ actorId: session.userId, actorRole: session.globalRole, caseId });
  if (!requested.ok) return mutationFailureResponse(requested)!;

  const completed = await completeDraft({ caseId, draftRequestId: requested.data.draftRequestId });
  if (!completed.ok) {
    return Response.json({ message: completed.reason, state: (await prisma.case.findUnique({ where: { id: caseId }, select: { state: true } }))?.state }, { status: 502 });
  }

  return Response.json({ caseId: completed.data.caseId, state: completed.data.toState });
}
