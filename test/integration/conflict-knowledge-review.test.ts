import { describe, expect, it } from "vitest";
import { prisma } from "../../src/lib/prisma";
import { reviewDraft, issueRecommendation } from "../../src/domain/mutate";
import { seedKnowledgeCase } from "../fixtures/seedKnowledgeCase";

describe("core review on PostgreSQL", () => {
  it("preserves prior content and serializes concurrent corrections before human issuance", async () => {
    const { manager, caseRow, recommendation, explanation } = await seedKnowledgeCase();
    const input = { actorId: manager.id, actorRole: "CASE_MANAGER" as const, caseId: caseRow.id, recommendationId: recommendation.id, fields: { ...explanation, reasoning: "Preserve disagreement while checking policy records." }, reason: "Do not infer a cause from the reported experience." };
    const results = await Promise.all([reviewDraft(input), reviewDraft(input)]);
    expect(results.filter(r => r.ok)).toHaveLength(1);
    expect(results.filter(r => !r.ok)).toHaveLength(1);
    const versions = await prisma.recommendation.findMany({ where: { caseId: caseRow.id }, orderBy: { version: "asc" } });
    expect(versions).toHaveLength(2);
    expect(versions[0].explanation).toEqual(recommendation.explanation);
    expect(versions[0].status).toBe("SUPERSEDED");
    expect(versions[1].status).toBe("DRAFT");
    const events = await prisma.event.findMany({ where: { caseId: caseRow.id }, orderBy: { seq: "asc" } });
    expect(events.map(e => e.type)).toEqual(["RECOMMENDATION_DRAFTED", "NOTE_ADDED"]);
    expect(events.every(e => e.actorId === manager.id)).toBe(true);
    const issued = await issueRecommendation({ actorId: manager.id, actorRole: "CASE_MANAGER", caseId: caseRow.id });
    expect(issued.ok).toBe(true);
    const latest = await prisma.recommendation.findUniqueOrThrow({ where: { id: versions[1].id } });
    expect(latest.status).toBe("ISSUED");
    expect((latest.explanation as Record<string, unknown>).knowledge_sources).toEqual(explanation.knowledge_sources);
  });
});
