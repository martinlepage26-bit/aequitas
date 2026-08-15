import { requireSession } from "../../../../../lib/session";
import { prisma } from "../../../../../lib/prisma";
import { issueRecommendation, mutationFailureResponse } from "../../../../../domain/mutate";

// Section 16: "POST /api/recommendations/[id]/issue — case manager, with
// checklist payload". The checklist itself ("I have reviewed the cited
// evidence", "I confirm the stated limits are accurate", "I accept
// responsibility as the issuing reviewer" — Section 9's UI requirement) is
// not part of Section 6's state-machine guard list — it's a request-shape
// requirement, validated here as a 400 like every other route's required-
// field check, not folded into issueRecommendation()'s guard set.
export async function POST(request: Request, { params }: { params: Promise<{ recommendationId: string }> }) {
  const auth = await requireSession();
  if ("response" in auth) return auth.response;
  const { session } = auth;
  const { recommendationId } = await params;

  const body = await request.json().catch(() => null);
  const checklist = body?.checklist;
  const complete =
    checklist?.reviewedEvidence === true && checklist?.confirmedLimits === true && checklist?.acceptsResponsibility === true;
  if (!complete) {
    return Response.json(
      { message: "checklist.reviewedEvidence, checklist.confirmedLimits, and checklist.acceptsResponsibility must all be true." },
      { status: 400 }
    );
  }

  const recommendation = await prisma.recommendation.findUnique({ where: { id: recommendationId } });
  if (!recommendation) return Response.json({ message: "Recommendation not found." }, { status: 404 });

  const caseRow = await prisma.case.findUnique({ where: { id: recommendation.caseId } });
  // Defensive: this build only ever has one recommendation per case (no
  // versioning/supersede yet — M4 work), so this can't actually diverge
  // today, but a stale recommendationId must never silently issue whatever
  // the case's *current* recommendation happens to be.
  if (!caseRow || caseRow.currentRecommendationId !== recommendation.id) {
    return Response.json({ message: "Recommendation not found." }, { status: 404 });
  }

  const outcome = await issueRecommendation({ actorId: session.userId, actorRole: session.globalRole, caseId: recommendation.caseId });
  if (!outcome.ok) return mutationFailureResponse(outcome)!;

  return Response.json({ caseId: outcome.data.caseId, state: outcome.data.toState });
}
