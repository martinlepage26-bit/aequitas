import { requireSession } from "../../../../../lib/session";
import { prisma } from "../../../../../lib/prisma";
import type { ExplanationRecord } from "../../../../../domain/explanationRecord";

/** Draft maps are private to the assigned reviewer; parties see only issued maps. */
export async function GET(_request: Request, { params }: { params: Promise<{ caseId: string }> }) {
  const auth = await requireSession();
  if ("response" in auth) return auth.response;
  const { session } = auth;
  const { caseId } = await params;
  const missing = () => Response.json({ message: "Knowledge map not found." }, { status: 404 });
  const row = await prisma.case.findUnique({ where: { id: caseId } });
  if (!row) return missing();
  const manager = session.globalRole === "CASE_MANAGER" && session.userId === row.caseManagerId;
  const party = session.userId === row.complainantId || session.userId === row.respondentId;
  if ((!manager && !party) || !row.currentRecommendationId) return missing();
  const recommendation = await prisma.recommendation.findUnique({ where: { id: row.currentRecommendationId } });
  if (!recommendation || recommendation.caseId !== caseId || (!manager && recommendation.status !== "ISSUED")) return missing();
  const explanation = recommendation.explanation as unknown as ExplanationRecord;
  if (!explanation.conflict_knowledge) return missing();
  return Response.json({
    caseId, recommendationId: recommendation.id, version: recommendation.version,
    status: recommendation.status, reviewer: explanation.reviewer,
    model: explanation.model, map: explanation.conflict_knowledge,
    sources: explanation.knowledge_sources ?? [],
  }, { headers: { "Cache-Control": "private, no-store" } });
}
