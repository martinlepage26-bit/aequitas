import { randomUUID } from "node:crypto";
import { prisma } from "../../src/lib/prisma";
import type { Prisma } from "../../src/generated/prisma";
import type { ExplanationRecord } from "../../src/domain/explanationRecord";
import { validMap, sources } from "./conflictKnowledge";

/** Synthetic preconditions only. No AI call or real participant information. */
export async function seedKnowledgeCase() {
  const [manager, complainant, respondent] = await Promise.all([
    prisma.user.create({ data: { email: `core-manager-${randomUUID()}@example.com`, displayName: "Core Reviewer", globalRole: "CASE_MANAGER" } }),
    prisma.user.create({ data: { email: `core-party-${randomUUID()}@example.com`, displayName: "Core Complainant", globalRole: "COMPLAINANT" } }),
    prisma.user.create({ data: { email: `core-party-${randomUUID()}@example.com`, displayName: "Core Respondent", globalRole: "RESPONDENT" } }),
  ]);
  const caseRow = await prisma.case.create({ data: { referenceNumber: `CORE-${randomUUID()}`, state: "DRAFTING", category: "EMPLOYMENT", simulated: true, complainantId: complainant.id, respondentId: respondent.id, caseManagerId: manager.id } });
  const positions = await Promise.all(sources.map((s, index) => prisma.positionStatement.create({ data: { caseId: caseRow.id, partyId: index === 0 ? complainant.id : respondent.id, body: s.fields.body!, locale: s.locale!, version: s.version! } })));
  const registry = sources.map((s, i) => ({ ...s, id: `position:${positions[i].id}`, record_id: positions[i].id, created_at: positions[i].createdAt.toISOString() }));
  const map = validMap();
  for (const node of [...map.claims, ...map.contexts]) {
    for (const citation of node.citations) citation.source_id = registry[sources.findIndex(s => s.id === citation.source_id)].id;
  }
  map.triangulation.source_groups.forEach((g, i) => { g.source_ids = [registry[i].id]; });
  const explanation: ExplanationRecord = {
    summary: "The accounts disagree.", proposed_outcome: "Review dated policy records.", reasoning: "The proposed policy change remains disputed.", evidence_citations: [],
    limits: ["No independent verification."], not_considered: ["Missing policy records."],
    conflict_knowledge: map, knowledge_sources: registry, model: { id: "synthetic-test", prompt_version: "2026-09-20.1" }, reviewer: { user_id: null, issued_at: null },
  };
  const recommendation = await prisma.recommendation.create({ data: { caseId: caseRow.id, version: 1, status: "DRAFT", explanation: explanation as unknown as Prisma.InputJsonValue, modelId: "synthetic-test", promptVersion: "2026-09-20.1" } });
  await prisma.case.update({ where: { id: caseRow.id }, data: { currentRecommendationId: recommendation.id } });
  return { manager, complainant, respondent, caseRow, recommendation, explanation };
}
