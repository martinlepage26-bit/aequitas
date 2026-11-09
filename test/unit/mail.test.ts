import { afterEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  notification: { findMany: vi.fn(), update: vi.fn() },
  scheduledOperationHeartbeat: { updateMany: vi.fn() },
}));
vi.mock("../../src/lib/prisma", () => ({ prisma: db }));
import {
  CASE_AWAITING_MANAGER_KIND,
  RECOMMENDATION_APPROVAL_REQUIRED_KIND,
  CASE_REOPENED_KIND,
  CASE_AGENT_POSITIONS_REQUESTED_KIND,
  OUTCOME_NEEDS_ANSWER_KIND,
  deliverPendingNotifications,
  emailConfigured,
  notificationEmail,
} from "../../src/lib/mail";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetAllMocks(); });
function configure() {
  vi.stubEnv("RESEND_API_KEY", "test-key");
  vi.stubEnv("EMAIL_FROM", "aequitas@pharos-ai.ca");
  vi.stubEnv("EMAIL_REPLY_TO", "aequitas@pharos-ai.ca");
  vi.stubEnv("APP_URL", "https://aequitas.example");
  vi.stubEnv("AEQUITAS_EMAIL_OUTBOX_ENCRYPTION_KEY", "synthetic-email-outbox-key-for-mail-unit-tests");
}

describe("Resend notification delivery", () => {
  it("honestly reports missing configuration and does not send", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(emailConfigured()).toBe(false);
    expect(await deliverPendingNotifications("case-1")).toEqual({ accepted: 0, pending: true });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("requires an independent outbox encryption key before reporting email delivery as configured", () => {
    configure();
    vi.stubEnv("AEQUITAS_EMAIL_OUTBOX_ENCRYPTION_KEY", "too-short");
    expect(emailConfigured()).toBe(false);
  });

  it("keeps failed notifications pending and retries with the same idempotency key", async () => {
    configure();
    db.notification.findMany.mockResolvedValue([{ id: "notification-1", caseId: "case-1", locale: "en-CA", user: { email: "recipient@example.com" } }]);
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: "unavailable" }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ id: "resend-2" }));
    vi.stubGlobal("fetch", fetch);

    expect(await deliverPendingNotifications("case-1")).toEqual({ accepted: 0, pending: true });
    expect(db.notification.update).toHaveBeenCalledTimes(1);
    expect(db.notification.update.mock.calls[0][0].data).toEqual({ attempts: { increment: 1 }, lastAttemptAt: expect.any(Date) });
    expect(await deliverPendingNotifications("case-1")).toEqual({ accepted: 1, pending: false });
    expect(db.notification.update.mock.calls[1][0].data).toMatchObject({ sentAt: expect.any(Date) });
    expect(fetch.mock.calls.map(([, request]) => request.headers["Idempotency-Key"])).toEqual(["notification/notification-1", "notification/notification-1"]);
  });

  it("records notification progress only when the scheduler runs the retry operation", async () => {
    configure();
    db.notification.findMany.mockResolvedValue([{
      id: "notification-scheduled",
      kind: CASE_AWAITING_MANAGER_KIND,
      caseId: "case-secret",
      locale: "en-CA",
      user: { email: "manager@example.com" },
      case: { referenceNumber: "AE-2026-000111", category: "TENANCY" },
    }]);
    db.scheduledOperationHeartbeat.updateMany.mockResolvedValue({ count: 1 });
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(Response.json({ id: "resend-scheduled" })));
    vi.stubGlobal("fetch", fetch);

    const oneOffResult = await deliverPendingNotifications();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(oneOffResult).toEqual({ accepted: 1, pending: false });
    expect(db.scheduledOperationHeartbeat.updateMany).not.toHaveBeenCalled();

    vi.stubEnv("AEQUITAS_SCHEDULER_OPERATION", "notification_retry");
    db.notification.findMany.mockResolvedValue([{
      id: "notification-scheduled",
      kind: CASE_AWAITING_MANAGER_KIND,
      caseId: "case-secret",
      locale: "en-CA",
      user: { email: "manager@example.com" },
      case: { referenceNumber: "AE-2026-000111", category: "TENANCY" },
    }]);
    expect(await deliverPendingNotifications()).toEqual({ accepted: 1, pending: false });
    expect(db.scheduledOperationHeartbeat.updateMany).toHaveBeenCalledWith({
      where: { name: "notification_retry", lastOutcome: "RUNNING" },
      data: { lastHeartbeatAt: expect.any(Date) },
    });
  });

  it("tells case managers only the reference and category, in their language", async () => {
    configure();
    const description = "The landlord kept the deposit after move-out.";
    const french = notificationEmail({ kind: CASE_AWAITING_MANAGER_KIND, locale: "fr-CA", caseId: "case-secret", referenceNumber: "AE-2026-000111", category: "TENANCY" });
    expect(french.subject).toBe("Un nouveau dossier attend un gestionnaire");
    expect(french.text).toContain("AE-2026-000111");
    expect(french.text).toContain("Logement locatif");
    expect(french.text).toContain("https://aequitas.example/fr-CA/cases");
    expect(french.text).not.toContain("case-secret");
    expect(french.text).not.toContain(description);

    const english = notificationEmail({ kind: CASE_AWAITING_MANAGER_KIND, locale: "en-CA", caseId: "case-secret", referenceNumber: "AE-2026-000111", category: "TENANCY" });
    expect(english.subject).toBe("A new case is waiting for a case manager");
    expect(english.text).toContain("Tenancy");
    expect(english.text).toContain("https://aequitas.example/en-CA/cases");
    expect(english.text).not.toContain(description);

    db.notification.findMany.mockResolvedValue([{
      id: "notification-mgr", kind: CASE_AWAITING_MANAGER_KIND, caseId: "case-secret", locale: "en-CA",
      user: { email: "manager@example.com" },
      case: { referenceNumber: "AE-2026-000111", category: "TENANCY", disputeDescription: description },
    }]);
    const fetch = vi.fn().mockResolvedValue(Response.json({ id: "resend-mgr" }));
    vi.stubGlobal("fetch", fetch);
    expect(await deliverPendingNotifications("case-secret")).toEqual({ accepted: 1, pending: false });
    const sent = JSON.parse(fetch.mock.calls[0][1].body);
    expect(sent.text).toContain("AE-2026-000111");
    expect(sent.text).toContain("Tenancy");
    expect(sent.text).not.toContain(description);
    expect(sent.text).not.toContain("case-secret");
  });

  it("localizes independent agent-approval alerts without exposing dispute content", () => {
    configure();
    const description = "The buyer's file contains sensitive personal details.";
    const french = notificationEmail({ kind: RECOMMENDATION_APPROVAL_REQUIRED_KIND, locale: "fr-CA", caseId: "case-secret", referenceNumber: "AE-2026-000112", category: "RETAIL" });
    const english = notificationEmail({ kind: RECOMMENDATION_APPROVAL_REQUIRED_KIND, locale: "en-CA", caseId: "case-secret", referenceNumber: "AE-2026-000112", category: "RETAIL" });

    expect(french.subject).toBe("Un dossier attend une approbation indépendante");
    expect(french.text).toContain("AE-2026-000112");
    expect(french.text).toContain("https://aequitas.example/fr-CA/cases/case-secret");
    expect(english.subject).toBe("A case needs independent sign-off");
    expect(english.text).toContain("AE-2026-000112");
    expect(english.text).toContain("https://aequitas.example/en-CA/cases/case-secret");
    expect(`${french.text} ${english.text}`).not.toContain(description);
  });

  it("localizes outcome, reopening and position requests without including the other party's outcome", () => {
    configure();
    const frenchAnswer = notificationEmail({ kind: OUTCOME_NEEDS_ANSWER_KIND, locale: "fr-CA", caseId: "case-1" });
    const englishAnswer = notificationEmail({ kind: OUTCOME_NEEDS_ANSWER_KIND, locale: "en-CA", caseId: "case-1" });
    expect(frenchAnswer.subject).toBe("Un nouveau résultat demande votre réponse");
    expect(frenchAnswer.text).toContain("Votre réponse précédente ne s'applique plus.");
    expect(englishAnswer.subject).toBe("A new outcome needs your answer");
    expect(englishAnswer.text).toContain("Your earlier answer no longer applies.");
    expect(`${frenchAnswer.text} ${englishAnswer.text}`).not.toContain("COMPLAINANT-V2");

    const frenchReopened = notificationEmail({ kind: CASE_REOPENED_KIND, locale: "fr-CA", caseId: "case-1" });
    const englishReopened = notificationEmail({ kind: CASE_REOPENED_KIND, locale: "en-CA", caseId: "case-1" });
    expect(frenchReopened.subject).toBe("Le dossier a été rouvert");
    expect(englishReopened.subject).toBe("The case was reopened");
    expect(`${frenchReopened.text} ${englishReopened.text}`).not.toContain("COMPLAINANT-V2");

    const frenchPositions = notificationEmail({ kind: CASE_AGENT_POSITIONS_REQUESTED_KIND, locale: "fr-CA", caseId: "case-1" });
    const englishPositions = notificationEmail({ kind: CASE_AGENT_POSITIONS_REQUESTED_KIND, locale: "en-CA", caseId: "case-1" });
    expect(frenchPositions.text).toContain("soumettre ou mettre à jour votre position");
    expect(englishPositions.text).toContain("submit or update your position");
  });

  it("states the role-specific participation-ending rule in both agent enrollment emails", () => {
    configure();
    const french = notificationEmail({ kind: "agent_managing", locale: "fr-CA", caseId: "case-1" });
    const english = notificationEmail({ kind: "agent_managing", locale: "en-CA", caseId: "case-1" });

    expect(french.text).toContain("La partie plaignante peut mettre fin à sa participation avant la fermeture");
    expect(french.text).toContain("la partie répondante ne peut le faire que si le programme le permet");
    expect(english.text).toContain("The complainant can end participation before closure");
    expect(english.text).toContain("the respondent can do so only when the program allows it");
    expect(`${french.text} ${english.text}`).not.toContain("at any time");
  });
});
