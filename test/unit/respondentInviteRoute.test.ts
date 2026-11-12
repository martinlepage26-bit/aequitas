import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  transaction: vi.fn(),
  queryRaw: vi.fn(),
  caseFind: vi.fn(),
  invitationFindFirst: vi.fn(),
  invitationCreate: vi.fn(),
  invitationUpdateMany: vi.fn(),
  invitationFindUnique: vi.fn(),
  invitationUpdate: vi.fn(),
  issueInviteToken: vi.fn(),
  invitePath: vi.fn(),
  emailConfigured: vi.fn(),
  sendInvitationEmail: vi.fn(),
}));

vi.mock("../../src/lib/session", () => ({ requireSession: mocks.session }));
vi.mock("../../src/lib/invite", () => ({ issueInviteToken: mocks.issueInviteToken, invitePath: mocks.invitePath }));
vi.mock("../../src/lib/mail", () => ({ emailConfigured: mocks.emailConfigured, sendInvitationEmail: mocks.sendInvitationEmail }));
vi.mock("../../src/lib/prisma", () => ({
  prisma: {
    $transaction: mocks.transaction,
    case: { findUnique: mocks.caseFind },
    invitation: { update: mocks.invitationUpdate },
  },
}));

import { POST } from "../../src/app/api/cases/[caseId]/invite-respondent/route";

const expiresAt = new Date("2026-11-10T12:00:00.000Z");
const tx = {
  $queryRaw: mocks.queryRaw,
  case: { findUnique: mocks.caseFind },
  invitation: {
    findFirst: mocks.invitationFindFirst,
    create: mocks.invitationCreate,
    updateMany: mocks.invitationUpdateMany,
    findUnique: mocks.invitationFindUnique,
  },
};
const params = { params: Promise.resolve({ caseId: "case-1" }) };
const request = () => new Request("http://localhost/api/cases/case-1/invite-respondent", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ confirmedEmail: "respondent@example.org" }),
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.transaction.mockImplementation(async (work: (client: typeof tx) => Promise<unknown>) => work(tx));
  mocks.session.mockResolvedValue({ session: { userId: "complainant-1", globalRole: "COMPLAINANT" } });
  mocks.caseFind.mockResolvedValue({
    id: "case-1", deletionStartedAt: null, state: "OPEN", complainantId: "complainant-1", respondentId: "respondent-1",
    respondent: { email: "respondent@example.org", locale: "fr-CA", _count: { credentials: 0 } },
  });
  mocks.invitationFindFirst.mockResolvedValue(null);
  mocks.invitationCreate.mockResolvedValue({ id: "invitation-1" });
  mocks.invitationUpdateMany.mockResolvedValue({ count: 1 });
  mocks.invitationFindUnique.mockResolvedValue({ id: "invitation-1", userId: "respondent-1", revokedAt: null, claimedAt: null });
  mocks.issueInviteToken.mockReturnValue({ token: "synthetic-token", expiresAt });
  mocks.invitePath.mockReturnValue("/fr-CA/invite/synthetic-token");
  mocks.emailConfigured.mockReturnValue(true);
  mocks.sendInvitationEmail.mockResolvedValue("accepted");
  vi.stubEnv("RESEND_API_KEY", "test-key");
  vi.stubEnv("EMAIL_FROM", "aequitas@example.org");
  vi.stubEnv("EMAIL_REPLY_TO", "aequitas@example.org");
  vi.stubEnv("APP_URL", "https://aequitas.example");
  vi.stubEnv("SESSION_SECRET", "synthetic-session-secret-for-respondent-route-tests");
  vi.stubEnv("AEQUITAS_EMAIL_OUTBOX_ENCRYPTION_KEY", "synthetic-email-outbox-key-for-respondent-route-tests");
});

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetAllMocks(); });

describe("respondent invitation delivery uncertainty", () => {
  it("keeps a link that may have been emailed and returns a clear 202 state", async () => {
    mocks.sendInvitationEmail.mockResolvedValue("pending");

    const response = await POST(request(), params);

    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ status: "delivery_pending", expiresAt: expiresAt.toISOString() });
    expect(mocks.invitationCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ userId: "respondent-1", issuedById: "complainant-1" }) });
    expect(mocks.invitationFindUnique).not.toHaveBeenCalled();
    expect(mocks.invitationUpdateMany).toHaveBeenCalledTimes(1);
    expect(mocks.sendInvitationEmail).toHaveBeenCalledWith({ invitationId: "invitation-1" });
  });

  it("does not rotate an active invitation whose email status is uncertain", async () => {
    mocks.invitationFindFirst.mockResolvedValue({ emailedAt: null, expiresAt });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    const response = await POST(request(), params);

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "delivery_uncertain", expiresAt: expiresAt.toISOString() });
    expect(mocks.invitationCreate).not.toHaveBeenCalled();
    expect(mocks.invitationUpdateMany).not.toHaveBeenCalled();
    expect(mocks.issueInviteToken).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("revokes a definitely rejected link before allowing a retry", async () => {
    mocks.sendInvitationEmail.mockResolvedValue("rejected");

    const response = await POST(request(), params);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ message: "Invitation email is unavailable." });
    expect(mocks.invitationFindUnique).toHaveBeenCalledWith({ where: { id: "invitation-1" } });
    expect(mocks.invitationUpdateMany).toHaveBeenLastCalledWith({
      where: { id: "invitation-1", revokedAt: null, claimedAt: null },
      data: expect.objectContaining({ revokedAt: expect.any(Date), deliveryPayloadCiphertext: null, deliveryLeaseUntil: null }),
    });
  });
});
