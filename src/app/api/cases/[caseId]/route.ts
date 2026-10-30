import { recordStaffAccess } from "../../../../domain/staffAccess";
import { requireSession } from "../../../../lib/session";
import { prisma } from "../../../../lib/prisma";
import { caseReadAccess } from "../../../../domain/caseAccess";
import { saveCaseDetails } from "../../../../domain/caseDetails";

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

  if (!caseReadAccess(caseRow, session)) return Response.json({ message: "Case not found." }, { status: 404 });

  await recordStaffAccess(caseId, session, "case");
  return Response.json({
    id: caseRow.id,
    referenceNumber: caseRow.referenceNumber,
    state: caseRow.state,
    category: caseRow.category,
    disputeDescription: caseRow.disputeDescription,
    amountAtStakeCents: caseRow.amountAtStakeCents,
    simulated: caseRow.simulated,
    complainant: caseRow.complainant,
    respondent: caseRow.respondent,
    caseManager: caseRow.caseManager,
    currentRecommendationId: caseRow.currentRecommendationId,
    createdAt: caseRow.createdAt,
    closedAt: caseRow.closedAt,
  });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ caseId: string }> }) {
  const auth = await requireSession();
  if ("response" in auth) return auth.response;
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return Response.json({ message: "Invalid dossier details." }, { status: 400 });
  const { caseId } = await params;
  const result = await saveCaseDetails({
    caseId,
    actorId: auth.session.userId,
    actorRole: auth.session.globalRole,
    expectedRevision: body.expectedRevision,
    category: body.category,
    disputeDescription: body.disputeDescription,
    amountAtStake: body.amountAtStake,
    respondentEmail: body.respondentEmail,
    respondentDisplayName: body.respondentDisplayName,
    simulated: body.simulated,
  });
  if (!result.ok) return Response.json({ message: result.message }, { status: result.status });
  return Response.json({ revision: result.revision, changed: result.changed }, { headers: { "Cache-Control": "private, no-store" } });
}
