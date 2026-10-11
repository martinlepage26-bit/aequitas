import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ session: vi.fn(), claims: vi.fn(), context: vi.fn(), assumptions: vi.fn() }));
vi.mock("../../src/lib/session", () => ({ requireSession: mocks.session }));
vi.mock("../../src/domain/pipeline/writes", () => ({
  runClaimDecomposition: mocks.claims,
  runContextMapping: mocks.context,
  runAssumptionExtraction: mocks.assumptions,
}));
vi.mock("../../src/domain/mutate", () => ({
  mutationFailureResponse: (result: { step: string; reason: string }) =>
    Response.json({ message: result.reason }, { status: result.step === "not-found" ? 404 : result.step === "authorize-role" ? 403 : 409 }),
}));
import { POST } from "../../src/app/api/cases/[caseId]/pipeline/run/route";

const params = { params: Promise.resolve({ caseId: "case1" }) };
const request = (body: unknown) =>
  new Request("http://localhost/api/cases/case1/pipeline/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ session: { userId: "manager1", globalRole: "CASE_MANAGER" } });
  for (const fn of [mocks.claims, mocks.context, mocks.assumptions]) fn.mockResolvedValue({ ok: true, data: { ids: ["p1", "p2"] } });
});

describe("pipeline run HTTP contract", () => {
  it("returns 401 without a session and calls no model", async () => {
    mocks.session.mockResolvedValue({ response: new Response(null, { status: 401 }) });
    expect((await POST(request({ step: "claims" }), params)).status).toBe(401);
    expect(mocks.claims).not.toHaveBeenCalled();
  });

  it.each([[{}], [{ step: "synthesis" }], [{ step: "__proto__" }], [{ step: 1 }]])("rejects an unknown step %j", async (body) => {
    expect((await POST(request(body), params)).status).toBe(400);
    expect(mocks.claims).not.toHaveBeenCalled();
    expect(mocks.context).not.toHaveBeenCalled();
    expect(mocks.assumptions).not.toHaveBeenCalled();
  });

  it.each([
    ["claims", () => mocks.claims],
    ["context", () => mocks.context],
    ["assumptions", () => mocks.assumptions],
  ] as const)("runs %s with the session actor, ignoring forged author fields", async (step, fn) => {
    const response = await POST(request({ step, actorId: "forged", actorRole: "ADMIN" }), params);
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ step, ids: ["p1", "p2"] });
    expect(fn()).toHaveBeenCalledWith({ caseId: "case1", actorId: "manager1", actorRole: "CASE_MANAGER" });
  });

  it("passes guard failures through, including the flag-off and acknowledgement gates", async () => {
    mocks.claims.mockResolvedValue({ ok: false, step: "guard", reason: "Claim decomposition waits until a person acknowledges an assumption." });
    const response = await POST(request({ step: "claims" }), params);
    expect(response.status).toBe(409);
    expect((await response.json()).message).toContain("acknowledges an assumption");
  });

  it.each([["not-found", 404], ["authorize-role", 403]])("retains denied %s status", async (step, status) => {
    mocks.claims.mockResolvedValue({ ok: false, step, reason: "no" });
    expect((await POST(request({ step: "claims" }), params)).status).toBe(status);
  });
});
