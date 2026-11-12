import { randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { GlobalRole } from "../../src/generated/prisma";
import { prisma } from "../../src/lib/prisma";
import english from "../../messages/en-CA.json";
import french from "../../messages/fr-CA.json";

const auth = vi.hoisted(() => ({ current: null as { userId: string; globalRole: GlobalRole; authMethod: "passkey" } | null, locale: "en-CA" as "en-CA" | "fr-CA" }));
vi.mock("../../src/lib/session", () => ({
  getSession: async () => auth.current,
  requireSession: async () => auth.current ? { session: auth.current } : { response: Response.json({ message: "Not authenticated." }, { status: 401 }) },
}));
vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("NOT_FOUND"); },
  redirect: (path: string) => { throw new Error(`REDIRECT:${path}`); },
}));
vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: string) => (key: string) => {
    let value: unknown = auth.locale === "fr-CA" ? french : english;
    for (const segment of [...namespace.split("."), ...key.split(".")]) value = (value as Record<string, unknown>)[segment];
    if (typeof value !== "string") throw new Error("Missing translation");
    return value;
  },
}));
vi.mock("../../src/app/[locale]/cases/CaseTable", () => ({ default: () => null }));
import { GET, POST } from "../../src/app/api/cases/[caseId]/deletion/route";
import DeletionRequestPage from "../../src/app/[locale]/cases/[caseId]/deletion/page";
import CaseListPage from "../../src/app/[locale]/cases/page";

let owner: { id: string };
let respondent: { id: string };
let stranger: { id: string };
let admin: { id: string };
function signIn(userId: string, globalRole: GlobalRole = "COMPLAINANT") { auth.current = { userId, globalRole, authMethod: "passkey" }; }
function context(caseId: string) { return { params: Promise.resolve({ caseId }) }; }
function request(caseId: string, method = "GET") { return new Request(`http://localhost/api/cases/${caseId}/deletion`, { method }); }
async function fixture() {
  return prisma.case.create({ data: { referenceNumber: `DELETION-ACCESS-${randomUUID()}`, state: "CLOSED", closedAt: new Date("2024-11-12T12:00:00Z"), complainantId: owner.id, respondentId: respondent.id, simulated: true, disputeDescription: "PRIVATE_CASE_NARRATIVE_NOT_IN_RECEIPT" } });
}
async function render(caseId: string, locale: "en-CA" | "fr-CA") {
  auth.locale = locale;
  return renderToStaticMarkup(await DeletionRequestPage({ params: Promise.resolve({ caseId, locale }) }));
}
beforeAll(async () => {
  const stamp = randomUUID();
  [owner, respondent, stranger, admin] = await Promise.all([
    prisma.user.create({ data: { email: `request-owner-${stamp}@example.org`, displayName: "PRIVATE_REQUESTER_NAME", globalRole: "COMPLAINANT" } }),
    prisma.user.create({ data: { email: `request-respondent-${stamp}@example.org`, displayName: "PRIVATE_RESPONDENT_NAME", globalRole: "RESPONDENT" } }),
    prisma.user.create({ data: { email: `request-stranger-${stamp}@example.org`, displayName: "Unrelated party", globalRole: "COMPLAINANT" } }),
    prisma.user.create({ data: { email: `request-admin-${stamp}@example.org`, displayName: "Administrator", globalRole: "ADMIN" } }),
  ]);
});
beforeEach(() => { auth.current = null; auth.locale = "en-CA"; });
afterAll(async () => { await prisma.$disconnect(); });

// Unique frozen/append-only fixtures remain in this disposable database.
describe("authenticated case deletion request and receipt", () => {
  it("requires authentication for both API methods and redirects the receipt page to sign-in", async () => {
    const row = await fixture();
    expect((await POST(request(row.id, "POST"), context(row.id))).status).toBe(401);
    expect((await GET(request(row.id), context(row.id))).status).toBe(401);
    await expect(render(row.id, "fr-CA")).rejects.toThrow("REDIRECT:");
    expect(await prisma.caseDeletion.count({ where: { caseId: row.id } })).toBe(0);
  });

  it("rejects unrelated requesters and reveals neither existing nor unknown receipts", async () => {
    const row = await fixture();
    signIn(stranger.id);
    const rejected = await POST(request(row.id, "POST"), context(row.id));
    expect(rejected.status).toBe(403);
    expect(await rejected.json()).toEqual({ code: "FORBIDDEN" });
    expect(await prisma.caseDeletion.count({ where: { caseId: row.id } })).toBe(0);
    signIn(owner.id);
    expect((await POST(request(row.id, "POST"), context(row.id))).status).toBe(202);
    signIn(stranger.id);
    for (const caseId of [row.id, randomUUID()]) {
      const response = await GET(request(caseId), context(caseId));
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ code: "NOT_FOUND" });
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      await expect(render(caseId, "en-CA")).rejects.toThrow("NOT_FOUND");
    }
  });

  it("records an idempotent party request without granting disposal or disclosing case content", async () => {
    const row = await fixture();
    signIn(owner.id);
    const first = await POST(request(row.id, "POST"), context(row.id));
    const receipt = await first.json();
    expect(first.status).toBe(202);
    expect(first.headers.get("Cache-Control")).toBe("private, no-store");
    expect(receipt).toEqual({ id: expect.any(String), status: "REQUESTED", eligibleAt: "2025-11-12T12:00:00.000Z", holdState: "UNKNOWN" });
    const second = await POST(request(row.id, "POST"), context(row.id));
    expect(second.status).toBe(202);
    expect(await second.json()).toEqual(receipt);
    expect(await prisma.caseDeletion.count({ where: { caseId: row.id } })).toBe(1);
    expect((await prisma.caseDeletion.findUniqueOrThrow({ where: { caseId: row.id } })).approvedAt).toBeNull();
    expect((await prisma.case.findUniqueOrThrow({ where: { id: row.id } })).deletionStartedAt).toBeNull();
    signIn(respondent.id, "RESPONDENT");
    expect((await POST(request(row.id, "POST"), context(row.id))).status).toBe(202);
    const response = await GET(request(row.id), context(row.id));
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain("PRIVATE_");
    expect(text).not.toContain("requestedById");
    expect(text).not.toContain("EvidenceDigest");
  });

  it("keeps a minimal bilingual request receipt available after the case freezes", async () => {
    const row = await fixture();
    signIn(owner.id);
    await POST(request(row.id, "POST"), context(row.id));
    await prisma.case.update({ where: { id: row.id }, data: { deletionStartedAt: new Date() } });
    await prisma.caseDeletion.update({ where: { caseId: row.id }, data: { frozenAt: new Date(), status: "FROZEN" } });
    expect((await GET(request(row.id), context(row.id))).status).toBe(200);
    expect((await POST(request(row.id, "POST"), context(row.id))).status).toBe(202);
    for (const locale of ["en-CA", "fr-CA"] as const) {
      const messages = locale === "fr-CA" ? french : english;
      const html = await render(row.id, locale);
      expect(html).toContain(messages.deletionRequest.title);
      expect(html).toContain(messages.deletionRequest.frozen);
      expect(html).toContain(messages.deletionRequest.hold);
      expect(html).toContain(`/${locale}/cases`);
      expect(html).not.toContain("PRIVATE_");
      expect(html).not.toContain("example.org");
      expect(html).not.toContain("<button");
    }
  });

  it("authorizes the original requester and administrator when the case row is absent", async () => {
    // Receipt fixture for already-purged content; the erasure procedure is
    // exercised separately under dedicated restricted roles in test:retention.
    const caseId = randomUUID();
    const job = await prisma.caseDeletion.create({ data: {
      caseId, policyVersion: "measured-review-2026-11-12-v1", eligibleAt: new Date("2025-11-12T12:00:00Z"), requestedById: owner.id,
      status: "COMPLETED", holdState: "CLEAR", frozenAt: new Date(), localPurgedAt: new Date(), completedAt: new Date(),
      copies: { create: [{ store: "DOWNLOADED_EXPORTS", status: "OUTSIDE_CONTROL" }] },
    } });
    signIn(owner.id);
    const response = await GET(request(caseId), context(caseId));
    expect(response.status).toBe(200);
    expect((await response.json()).status).toBe("COMPLETED");
    const repeated = await POST(request(caseId, "POST"), context(caseId));
    expect(repeated.status).toBe(202);
    expect((await repeated.json()).id).toBe(job.id);
    for (const locale of ["en-CA", "fr-CA"] as const) {
      const messages = locale === "fr-CA" ? french : english;
      const html = await render(caseId, locale);
      expect(html).toContain(messages.deletionRequest.completed);
      expect(html).toContain(messages.deletionRequest.outside);
      expect(html).toContain(messages.deletionRequest.account);
      expect(html).not.toContain("PRIVATE_");
    }
    signIn(admin.id, "ADMIN");
    expect((await GET(request(caseId), context(caseId))).status).toBe(200);
    signIn(stranger.id);
    expect((await GET(request(caseId), context(caseId))).status).toBe(404);
    await expect(render(caseId, "fr-CA")).rejects.toThrow("NOT_FOUND");
  });

  it("lists only the signed-in requester's receipts after their case rows are absent", async () => {
    const ownCaseId = randomUUID();
    const otherCaseId = randomUUID();
    for (const [caseId, requestedById] of [[ownCaseId, owner.id], [otherCaseId, stranger.id]]) {
      await prisma.caseDeletion.create({ data: { caseId, requestedById, policyVersion: "measured-review-2026-11-12-v1", eligibleAt: new Date("2025-11-12T12:00:00Z"), status: "LOCAL_PURGED", localPurgedAt: new Date() } });
    }
    signIn(owner.id);
    for (const locale of ["en-CA", "fr-CA"] as const) {
      auth.locale = locale;
      const messages = locale === "fr-CA" ? french : english;
      const html = renderToStaticMarkup(await CaseListPage({ params: Promise.resolve({ locale }) }));
      expect(html).toContain(messages.deletionRequest.listTitle);
      expect(html).toContain(messages.deletionRequest.requestedOn);
      expect(html).toContain(messages.deletionRequest.localPurged);
      expect(html).toContain(`/${locale}/cases/${ownCaseId}/deletion`);
      expect(html).not.toContain(`/${locale}/cases/${otherCaseId}/deletion`);
      expect(html).not.toContain("PRIVATE_");
      expect(html).not.toContain("example.org");
    }
  });
});
