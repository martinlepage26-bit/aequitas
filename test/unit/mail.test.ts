import { afterEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ invitation: { update: vi.fn() }, notification: { findMany: vi.fn(), update: vi.fn() } }));
vi.mock("../../src/lib/prisma", () => ({ prisma: db }));
import { emailConfigured, sendInvitationEmail, deliverPendingNotifications } from "../../src/lib/mail";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetAllMocks(); });
function configure() {
  vi.stubEnv("RESEND_API_KEY", "test-key"); vi.stubEnv("EMAIL_FROM", "aequitas@pharos-ai.ca");
  vi.stubEnv("EMAIL_REPLY_TO", "aequitas@pharos-ai.ca"); vi.stubEnv("APP_URL", "https://aequitas.example");
}

describe("Resend delivery", () => {
  it("honestly reports missing configuration and does not send", async () => {
    vi.stubEnv("RESEND_API_KEY", ""); const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    expect(emailConfigured()).toBe(false);
    expect(await sendInvitationEmail({ email: "recipient@example.com", locale: "fr-CA", claimPath: "/fr-CA/invite/test", invitationId: "invite-1" })).toBe("not_configured");
    expect(fetch).not.toHaveBeenCalled(); expect(db.invitation.update).not.toHaveBeenCalled();
  });
  it("sets the authorized From and Reply-To, localizes the invitation and marks provider acceptance", async () => {
    configure(); const fetch = vi.fn().mockResolvedValue(Response.json({ id: "resend-1" })); vi.stubGlobal("fetch", fetch);
    expect(await sendInvitationEmail({ email: "recipient@example.com", locale: "fr-CA", claimPath: "/fr-CA/invite/test", invitationId: "invite-1" })).toBe("accepted");
    const [url, request] = fetch.mock.calls[0]; expect(url).toBe("https://api.resend.com/emails");
    expect(JSON.parse(request.body)).toMatchObject({ from: "aequitas@pharos-ai.ca", reply_to: "aequitas@pharos-ai.ca", to: ["recipient@example.com"], subject: "Votre invitation à Aequitas", text: expect.stringContaining("https://aequitas.example/fr-CA/invite/test") });
    expect(request.headers["Idempotency-Key"]).toBe("invitation/invite-1");
    expect(db.invitation.update).toHaveBeenCalledWith({ where: { id: "invite-1" }, data: { emailedAt: expect.any(Date) } });
  });
  it("keeps failed notifications pending and retries with the same idempotency key", async () => {
    configure();
    db.notification.findMany.mockResolvedValue([{ id: "notification-1", caseId: "case-1", locale: "en-CA", user: { email: "recipient@example.com" } }]);
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ error: "unavailable" }, { status: 503 })).mockResolvedValueOnce(Response.json({ id: "resend-2" }));
    vi.stubGlobal("fetch", fetch);
    expect(await deliverPendingNotifications("case-1")).toEqual({ accepted: 0, pending: true });
    expect(db.notification.update).not.toHaveBeenCalled();
    expect(await deliverPendingNotifications("case-1")).toEqual({ accepted: 1, pending: false });
    expect(fetch.mock.calls.map(([, request]) => request.headers["Idempotency-Key"])).toEqual(["notification/notification-1", "notification/notification-1"]);
  });
});
