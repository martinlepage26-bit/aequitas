import { beforeEach, describe, expect, it, vi } from "vitest";
import { validMap, sources } from "../fixtures/conflictKnowledge";
const mocks = vi.hoisted(() => ({ session: vi.fn(), case: vi.fn(), recommendation: vi.fn() }));
vi.mock("../../src/lib/session", () => ({ requireSession: mocks.session }));
vi.mock("../../src/lib/prisma", () => ({ prisma: { case: { findUnique: mocks.case }, recommendation: { findUnique: mocks.recommendation } } }));
import { GET } from "../../src/app/api/cases/[caseId]/knowledge-map/route";
const read = () => GET(new Request("http://localhost/api/cases/case1/knowledge-map"), { params: Promise.resolve({ caseId: "case1" }) });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ session: { userId: "manager", globalRole: "CASE_MANAGER" } });
  mocks.case.mockResolvedValue({ id: "case1", caseManagerId: "manager", complainantId: "party1", respondentId: "party2", currentRecommendationId: "rec1" });
  mocks.recommendation.mockResolvedValue({ id: "rec1", caseId: "case1", status: "DRAFT", version: 1, explanation: { conflict_knowledge: validMap(), knowledge_sources: sources, reviewer: { user_id: null, issued_at: null } } });
});
describe("knowledge map confidentiality", () => {
  it("returns a draft only to its assigned manager, with no-store", async () => {
    const response = await read();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect((await response.json()).sources).toEqual(sources);
  });
  it.each([["party1", "COMPLAINANT"], ["other", "CASE_MANAGER"], ["admin", "ADMIN"]])("hides draft from %s", async (userId, globalRole) => {
    mocks.session.mockResolvedValue({ session: { userId, globalRole } });
    expect((await read()).status).toBe(404);
  });
  it("returns issued maps to parties", async () => {
    mocks.session.mockResolvedValue({ session: { userId: "party1", globalRole: "COMPLAINANT" } });
    mocks.recommendation.mockResolvedValue({ id: "rec1", caseId: "case1", status: "ISSUED", explanation: { conflict_knowledge: validMap() } });
    expect((await read()).status).toBe(200);
  });
  it("does not expose cross-case or legacy records as a map", async () => {
    mocks.recommendation.mockResolvedValue({ caseId: "other", explanation: { conflict_knowledge: validMap() } });
    expect((await read()).status).toBe(404);
    mocks.recommendation.mockResolvedValue({ caseId: "case1", explanation: {} });
    expect((await read()).status).toBe(404);
  });
  it("preserves authentication failure", async () => {
    mocks.session.mockResolvedValue({ response: new Response(null, { status: 401 }) });
    expect((await read()).status).toBe(401);
    expect(mocks.case).not.toHaveBeenCalled();
  });
});
