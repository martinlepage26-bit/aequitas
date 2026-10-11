import { requireSession } from "../../../../../lib/session";
import { prisma } from "../../../../../lib/prisma";
import { readResolutionView } from "../../../../../domain/resolution";
import { caseReadAccess } from "../../../../../domain/caseAccess";

// Phase 3: what currently blocks resolution (OPEN_CONTESTATION,
// APPROVAL_REQUIRED), the approver sign-off if any, and the contestations.
export async function GET(_request: Request, { params }: { params: Promise<{ caseId: string }> }) {
  const auth = await requireSession();
  if ("response" in auth) return auth.response;
  const { caseId } = await params;
  const [caseRow, user] = await Promise.all([
    prisma.case.findUnique({ where: { id: caseId } }),
    prisma.user.findUnique({ where: { id: auth.session.userId }, select: { isApprover: true } }),
  ]);
  const viewer = { userId: auth.session.userId, globalRole: auth.session.globalRole, isApprover: user?.isApprover ?? false };
  if (!caseRow || !caseReadAccess(caseRow, viewer)) return Response.json({ message: "Case not found." }, { status: 404 });
  const view = await readResolutionView(caseId, viewer);
  return Response.json(view, { headers: { "Cache-Control": "private, no-store" } });
}
