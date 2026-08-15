import { requireSession } from "../../../../lib/session";
import { prisma } from "../../../../lib/prisma";

// Section 16: "GET /api/cases/[id] — workspace projection (role-filtered)".
// Replaces an M0-era SQLite prototype route that answered this exact path
// with fake legacy data (see DECISIONS.md) — this is the real projection,
// same RBAC-404 posture as the workspace page and the events route.
export async function GET(request: Request, { params }: { params: Promise<{ caseId: string }> }) {
  const auth = await requireSession();
  if ("response" in auth) return auth.response;
  const { session } = auth;
  const { caseId } = await params;

  const caseRow = await prisma.case.findUnique({
    where: { id: caseId },
    include: {
      complainant: { select: { id: true, displayName: true } },
      respondent: { select: { id: true, displayName: true } },
      caseManager: { select: { id: true, displayName: true } },
    },
  });
  if (!caseRow) return Response.json({ message: "Case not found." }, { status: 404 });

  const isParty = session.userId === caseRow.complainantId || session.userId === caseRow.respondentId;
  const isManagerOrAdmin = session.globalRole === "CASE_MANAGER" || session.globalRole === "ADMIN";
  if (!isParty && !isManagerOrAdmin) return Response.json({ message: "Case not found." }, { status: 404 });

  return Response.json({
    id: caseRow.id,
    referenceNumber: caseRow.referenceNumber,
    state: caseRow.state,
    category: caseRow.category,
    simulated: caseRow.simulated,
    complainant: caseRow.complainant,
    respondent: caseRow.respondent,
    caseManager: caseRow.caseManager,
    currentRecommendationId: caseRow.currentRecommendationId,
    createdAt: caseRow.createdAt,
    closedAt: caseRow.closedAt,
  });
}
