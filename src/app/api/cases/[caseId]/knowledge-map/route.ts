import { withCaseOperation, CaseUnavailableError } from "../../../../../lib/caseOperation";
import { requireSession } from "../../../../../lib/session";
import { prisma } from "../../../../../lib/prisma";
import type { ExplanationRecord } from "../../../../../domain/explanationRecord";
import { filterExplanationForParty, hiddenSubmissionIds, type HiddenSubmissionIds } from "../../../../../domain/submissionVisibility";

/** Draft maps are private to the assigned reviewer; parties see only issued maps. */
export async function GET(_request: Request, { params }: { params: Promise<{ caseId: string }> }) {
  const auth = await requireSession();
  if ("response" in auth) return auth.response;
  const { session } = auth;
  const { caseId } = await params;
  try { return await withCaseOperation(caseId, "GET", async () => {

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
  const body = {
    caseId, recommendationId: recommendation.id, version: recommendation.version,
    status: recommendation.status, reviewer: explanation.reviewer,
    model: explanation.model, map: explanation.conflict_knowledge,
    sources: explanation.knowledge_sources ?? [],
  };
  const visible = party ? filterKnowledgeMapForParty(body, await hiddenSubmissionIds(caseId, session.userId)) : body;
  return Response.json(visible, { headers: { "Cache-Control": "private, no-store" } });

  }); } catch (error) { if (error instanceof CaseUnavailableError) { return Response.json({ message: "Case not found." }, { status: 404 }); } throw error; }
}

function filterKnowledgeMapForParty<T extends {
  map: NonNullable<ExplanationRecord["conflict_knowledge"]>;
  sources: NonNullable<ExplanationRecord["knowledge_sources"]>;
}>(body: T, hidden: HiddenSubmissionIds): T {
  const filtered = filterExplanationForParty({
    knowledge_sources: body.sources,
    conflict_knowledge: body.map,
  }, hidden);
  return {
    ...body,
    map: filtered.conflict_knowledge ?? body.map,
    sources: filtered.knowledge_sources ?? [],
  };
}
