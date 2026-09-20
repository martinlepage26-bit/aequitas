import { reviewDraft, mutationFailureResponse } from "../../../../../domain/mutate";
import { requireSession } from "../../../../../lib/session";
import { prisma } from "../../../../../lib/prisma";

// Section 16: "GET /api/cases/[id]/draft — case manager only". Section 10:
// "View draft recommendation: never (consumer/retailer), yes (case
// manager)" — a DRAFT-status recommendation is quarantined from parties at
// the API layer, not just hidden in the UI.
export async function GET(request: Request, { params }: { params: Promise<{ caseId: string }> }) {
  const auth = await requireSession();
  if ("response" in auth) return auth.response;
  const { session } = auth;
  const { caseId } = await params;

  const caseRow = await prisma.case.findUnique({ where: { id: caseId } });
  if (!caseRow) return Response.json({ message: "Case not found." }, { status: 404 });

  const isAssignedManager = session.globalRole === "CASE_MANAGER" && session.userId === caseRow.caseManagerId;
  if (!isAssignedManager) return Response.json({ message: "Case not found." }, { status: 404 });

  if (!caseRow.currentRecommendationId) {
    return Response.json({ message: "No draft recommendation exists for this case." }, { status: 404 });
  }
  const recommendation = await prisma.recommendation.findUnique({ where: { id: caseRow.currentRecommendationId } });
  if (!recommendation) return Response.json({ message: "Draft recommendation not found." }, { status: 404 });

  return Response.json({
    id: recommendation.id,
    caseId: recommendation.caseId,
    version: recommendation.version,
    status: recommendation.status,
    explanation: recommendation.explanation,
    modelId: recommendation.modelId,
    promptVersion: recommendation.promptVersion,
  });
}

/** Submit a complete correction with the base version, preserving an attributable history. */
export async function PATCH(request: Request, { params }: { params: Promise<{ caseId: string }> }) {
  const auth = await requireSession();
  if ("response" in auth) return auth.response;
  const { caseId } = await params;
  const body = await request.json().catch(() => null);
  if (typeof body?.recommendationId !== "string" || typeof body?.reason !== "string") {
    return Response.json({ message: "recommendationId, explanation and reason are required." }, { status: 400 });
  }
  const result = await reviewDraft({
    actorId: auth.session.userId, actorRole: auth.session.globalRole, caseId,
    recommendationId: body.recommendationId, fields: body.explanation, reason: body.reason,
  });
  if (!result.ok) return mutationFailureResponse(result)!;
  return Response.json({ caseId, state: result.data.toState });
}
