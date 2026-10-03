import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ session: vi.fn(), caseFind: vi.fn(), entries: vi.fn(), submit: vi.fn() }));
vi.mock("../../src/lib/session", () => ({ requireSession: mocks.session }));
vi.mock("../../src/lib/prisma", () => ({ prisma: { case: { findUnique: mocks.caseFind }, chronologyEntry: { findMany: mocks.entries } } }));
vi.mock("../../src/domain/mutate", () => ({ submitChronology: mocks.submit, mutationFailureResponse: (result: { step: string }) => Response.json({}, { status: result.step === "not-found" ? 404 : result.step === "authorize-role" ? 403 : 409 }) }));
import { GET, POST } from "../../src/app/api/cases/[caseId]/chronology/route";
const params = { params: Promise.resolve({ caseId: "case1" }) };
const request = (body: unknown) => new Request("http://localhost/api/cases/case1/chronology", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const input = { occurredOn: "2026-01-01", title: "Message", description: "I received the message.", locale: "en-CA" };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ session: { userId: "party1", globalRole: "COMPLAINANT" } });
  mocks.caseFind.mockResolvedValue({ id: "case1", state: "EVIDENCE_INTAKE", caseManagerId: "manager", complainantId: "party1", respondentId: "party2" });
  mocks.entries.mockResolvedValue([]);
  mocks.submit.mockResolvedValue({ ok: true, data: { caseId: "case1", toState: "EVIDENCE_INTAKE" } });
});
describe("chronology HTTP contract", () => {
  it("preserves authentication failure without querying case data", async () => {
    mocks.session.mockResolvedValue({ response: new Response(null, { status: 401 }) });
    expect((await GET(new Request("http://localhost/"), params)).status).toBe(401);
    expect((await POST(request(input), params)).status).toBe(401);
    expect(mocks.caseFind).not.toHaveBeenCalled(); expect(mocks.submit).not.toHaveBeenCalled();
  });
  it.each([["outsider", "COMPLAINANT"], ["otherManager", "CASE_MANAGER"]])("hides chronology from %s", async (userId, globalRole) => {
    mocks.session.mockResolvedValue({ session: { userId, globalRole } });
    expect((await GET(new Request("http://localhost/"), params)).status).toBe(404);
    expect(mocks.entries).not.toHaveBeenCalled();
  });
  it("allows a case party to read with private, no-store", async () => {
    const response = await GET(new Request("http://localhost/"), params);
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
  it("retains the existing administrator case-read policy", async () => {
    mocks.session.mockResolvedValue({ session: { userId: "admin", globalRole: "ADMIN" } });
    expect((await GET(new Request("http://localhost/"), params)).status).toBe(200);
  });
  it("rejects invalid dates and forged client author fields", async () => {
    expect((await POST(request({ ...input, occurredOn: "2026-02-31" }), params)).status).toBe(400);
    expect(mocks.submit).not.toHaveBeenCalled();
    expect((await POST(request({ ...input, actorId: "forged", actorRole: "ADMIN" }), params)).status).toBe(201);
    expect(mocks.submit).toHaveBeenCalledWith({ ...input, caseId: "case1", actorId: "party1", actorRole: "COMPLAINANT" });
  });
  it.each([["not-found", 404], ["authorize-role", 403], ["authorize-state", 409]])("retains denied %s status", async (step, status) => {
    mocks.submit.mockResolvedValue({ ok: false, step });
    expect((await POST(request(input), params)).status).toBe(status);
  });
});
