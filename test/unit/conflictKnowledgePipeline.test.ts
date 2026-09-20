import { beforeEach, describe, expect, it, vi } from "vitest";
import { validMap, sources } from "../fixtures/conflictKnowledge";
const mocks = vi.hoisted(() => ({
  caseFind: vi.fn(), evidenceFind: vi.fn(), positionFind: vi.fn(), recommendationFind: vi.fn(),
  draft: vi.fn(), transaction: vi.fn(), create: vi.fn(), update: vi.fn(), lock: vi.fn(), eventCreate: vi.fn(),
}));
vi.mock("../../src/lib/prisma", () => ({ prisma: {
  case: { findUnique: mocks.caseFind }, evidenceItem: { findMany: mocks.evidenceFind },
  positionStatement: { findFirst: mocks.positionFind }, recommendation: { findUnique: mocks.recommendationFind },
  $transaction: mocks.transaction,
} }));
vi.mock("../../src/ai/draftRecommendation", () => ({ draftRecommendation: mocks.draft }));
import { completeDraft, reviewDraft, issueRecommendation } from "../../src/domain/mutate";

const managerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
function explanation() {
  return { summary: "The accounts disagree.", proposed_outcome: "Review the dated policy records.", reasoning: "The reported policy change is disputed.", evidence_citations: [], limits: ["No independent verification."], not_considered: ["Policy records are missing."], conflict_knowledge: validMap(), knowledge_sources: sources, model: { id: "test-model", prompt_version: "2026-09-20.1" }, reviewer: { user_id: null, issued_at: null } };
}
const reviewInput = () => ({ actorId: managerId, actorRole: "CASE_MANAGER" as const, caseId: "case1", recommendationId: "rec1", fields: explanation(), reason: "Preserve the unresolved causal question." });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.caseFind.mockResolvedValue({ id: "case1", state: "DRAFTING", category: "EMPLOYMENT", caseManagerId: managerId, currentRecommendationId: "rec1", complainantId: "party1", respondentId: "party2", complainant: { locale: "fr-CA" }, respondent: { locale: "en-CA" } });
  mocks.evidenceFind.mockResolvedValue([]);
  mocks.positionFind.mockImplementation(({ where }) => {
    const source = sources[where.partyId === "party1" ? 0 : 1];
    return Promise.resolve({ id: source.record_id, body: source.fields.body, locale: source.locale, version: source.version, createdAt: new Date("2026-09-20T00:00:00Z") });
  });
  mocks.draft.mockResolvedValue({ ok: true, explanation: explanation() });
  mocks.recommendationFind.mockResolvedValue({ id: "rec1", caseId: "case1", status: "DRAFT", version: 1, explanation: explanation(), modelId: "test-model", promptVersion: "2026-09-20.1" });
  mocks.create.mockResolvedValue({ id: "rec2", version: 2 });
  mocks.lock.mockResolvedValue({ count: 1 });
  mocks.transaction.mockImplementation(async fn => fn({
    case: { update: vi.fn(), updateMany: mocks.lock },
    recommendation: { count: vi.fn().mockResolvedValue(1), findFirst: vi.fn().mockResolvedValue({ version: 1 }), create: mocks.create, update: mocks.update, updateMany: vi.fn() },
    event: { findFirst: vi.fn().mockResolvedValue(null), create: mocks.eventCreate },
    notification: { create: vi.fn() },
  }));
});
describe("conflict map persistence and review", () => {
  it("persists a validated map with server-owned source versions and draft audit event", async () => {
    expect((await completeDraft({ caseId: "case1" })).ok).toBe(true);
    const written = mocks.create.mock.calls[0][0].data;
    expect(written.status).toBe("DRAFT");
    expect(written.explanation.conflict_knowledge).toEqual(validMap());
    expect(written.explanation.knowledge_sources[0].created_at).toBe("2026-09-20T00:00:00.000Z");
    expect(mocks.eventCreate.mock.calls[0][0].data.type).toBe("RECOMMENDATION_DRAFTED");
  });
  it("rejects fabricated map quotations before a transaction or drafted event", async () => {
    const bad = explanation(); bad.conflict_knowledge.claims[0].citations[0].excerpt = "Invented";
    mocks.draft.mockResolvedValue({ ok: true, explanation: bad });
    expect((await completeDraft({ caseId: "case1" })).ok).toBe(false);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it("does not silently accept a legacy-shaped AI response", async () => {
    mocks.draft.mockResolvedValue({ ok: true, explanation: { ...explanation(), conflict_knowledge: undefined } });
    expect((await completeDraft({ caseId: "case1" })).ok).toBe(false);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("preserves the original on correction and attributes the new version to its human reviewer", async () => {
    expect((await reviewDraft(reviewInput())).ok).toBe(true);
    expect(mocks.update).toHaveBeenCalledWith({ where: { id: "rec1" }, data: { status: "SUPERSEDED" } });
    expect(mocks.create.mock.calls[0][0].data.explanation.reviewer.user_id).toBeNull();
    const events = mocks.eventCreate.mock.calls.map(c => c[0].data);
    expect(events[0].actorId).toBe(managerId);
    expect(events[1].payload.reason).toBe(reviewInput().reason);
  });
  it("rejects another manager and stale base versions", async () => {
    expect((await reviewDraft({ ...reviewInput(), actorId: "other" })).ok).toBe(false);
    mocks.recommendationFind.mockResolvedValue({ id: "old", caseId: "case1", status: "DRAFT" });
    expect((await reviewDraft(reviewInput())).ok).toBe(false);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it("returns a conflict if another operation replaces the draft before correction", async () => {
    mocks.lock.mockResolvedValue({ count: 0 });
    const result = await reviewDraft(reviewInput());
    expect(result.ok).toBe(false);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.eventCreate).not.toHaveBeenCalled();
  });
  it("cannot issue an obsolete version after concurrent correction", async () => {
    mocks.lock.mockResolvedValue({ count: 0 });
    const result = await issueRecommendation({ actorId: managerId, actorRole: "CASE_MANAGER", caseId: "case1" });
    expect(result.ok).toBe(false);
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("checks map integrity again before issuing", async () => {
    const bad = explanation(); bad.conflict_knowledge.relationships[0].to_id = "missing";
    mocks.recommendationFind.mockResolvedValue({ id: "rec1", caseId: "case1", status: "DRAFT", explanation: bad, promptVersion: "2026-09-20.1" });
    expect((await issueRecommendation({ actorId: managerId, actorRole: "CASE_MANAGER", caseId: "case1" })).ok).toBe(false);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
