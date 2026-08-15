import { requireSession } from "../../../../../lib/session";
import { closeCase, mutationFailureResponse } from "../../../../../domain/mutate";
import { generateExportBundle } from "../../../../../domain/exportBundle";
import { prisma } from "../../../../../lib/prisma";

// Section 16: "POST /api/cases/[id]/close — case manager". Section 6 row 16
// lists export.generated as one of close_case's own emitted events, so the
// bundle is generated here as the real precondition the guard checks
// (exportBundleGeneratedAndHashed), not a separate manual step the case
// manager has to remember — mirroring the request_draft -> complete_draft
// two-function chain M3 already established for "I/O-heavy prerequisite,
// then guarded transition" (S3 upload + PDF generation don't belong inside
// the state-transition DB transaction).
export async function POST(request: Request, { params }: { params: Promise<{ caseId: string }> }) {
  const auth = await requireSession();
  if ("response" in auth) return auth.response;
  const { session } = auth;
  const { caseId } = await params;

  const caseRow = await prisma.case.findUnique({ where: { id: caseId } });
  if (!caseRow) return Response.json({ message: "Case not found." }, { status: 404 });
  const isAssignedManager = session.globalRole === "CASE_MANAGER" && session.userId === caseRow.caseManagerId;
  if (!isAssignedManager) return Response.json({ message: "Case not found." }, { status: 404 });

  let bundle;
  try {
    bundle = await generateExportBundle({ caseId, actorId: session.userId });
  } catch (error) {
    return Response.json({ message: `Export bundle generation failed: ${error instanceof Error ? error.message : String(error)}` }, { status: 502 });
  }

  const outcome = await closeCase({ actorId: session.userId, actorRole: session.globalRole, caseId, exportSha256: bundle.sha256 });
  if (!outcome.ok) return mutationFailureResponse(outcome)!;
  return Response.json({ caseId: outcome.data.caseId, state: outcome.data.toState, export: bundle });
}
