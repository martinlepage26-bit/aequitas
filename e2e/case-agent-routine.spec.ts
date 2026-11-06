import "../src/lib/loadEnv";
import { randomUUID } from "node:crypto";
import { test, expect, type Browser, type BrowserContext } from "@playwright/test";
import { prisma } from "../src/lib/prisma";
import { signPayload } from "../src/lib/signedCookie";
import { SESSION_COOKIE } from "../src/lib/session";
import { createCase, submitCase } from "../src/domain/mutate";
import { runCaseAgent } from "../src/domain/caseAgent/agent";
import { verifyCase } from "../src/domain/verifyEvents";
import fr from "../messages/fr-CA.json";
import en from "../messages/en-CA.json";

// The whole routine path in the browser, with no case-manager account at
// all: a submitted case is taken by the agent, the respondent is invited,
// both parties upload evidence and positions through the UI (real scanning
// and extraction), the agent issues fixed-wording proposals, both parties
// consent in the UI, and the agent closes the case.
//
// Synthetic data only. The agent runs in this test process with a stub model;
// the invitation email goes to an intercepted fetch. Nothing leaves the machine.

const port = process.env.PLAYWRIGHT_PORT ?? 3000;
const DAY = 24 * 60 * 60 * 1000;
const ENV = {
  AEQUITAS_CASE_AGENT_ENABLED: "true",
  AEQUITAS_CASE_AGENT_MAX_AMOUNT_CENTS: "500000",
  AEQUITAS_CASE_AGENT_MAX_MODEL_CALLS_PER_UTC_DAY: "1000",
  AEQUITAS_CASE_AGENT_INTAKE_DAYS: "7",
  AEQUITAS_CASE_AGENT_RESPONSE_DAYS: "5",
  AEQUITAS_CASE_AGENT_RESPONDENT_MAY_WITHDRAW: "true",
  AEQUITAS_CASE_AGENT_CONSENT_ONLY_RESOLUTION: "true",
  AEQUITAS_PIPELINE_PROVIDER: "gemini",
  GEMINI_PROJECT_ID: "synthetic-e2e-project",
  GEMINI_MODEL: "gemini-3.8-flash",
  AEQUITAS_CASE_AGENT_PROCESSING_NOTICE_EN: "Synthetic E2E notice: case content would be sent to the configured model provider.",
  AEQUITAS_CASE_AGENT_PROCESSING_NOTICE_FR: "Avis E2E synthétique : le contenu du dossier serait transmis au fournisseur de modèle configuré.",
};
const NO_CALL_MODEL = { provider: "test", model: "not-called-before-proposal", async complete() { throw new Error("The model must not be called before both positions are submitted."); } };

async function contextFor(browser: Browser, userId: string, globalRole: string): Promise<BrowserContext> {
  const context = await browser.newContext();
  await context.addCookies([{ name: SESSION_COOKIE, value: signPayload({ purpose: "session", userId, globalRole, authMethod: "dev-bypass" }, 3600), url: `http://localhost:${port}` }]);
  return context;
}

async function withInterceptedEmail<T>(fn: () => Promise<T>): Promise<{ result: T; invitations: number }> {
  const saved = { RESEND_API_KEY: process.env.RESEND_API_KEY, EMAIL_FROM: process.env.EMAIL_FROM, EMAIL_REPLY_TO: process.env.EMAIL_REPLY_TO, APP_URL: process.env.APP_URL };
  const realFetch = globalThis.fetch;
  let invitations = 0;
  Object.assign(process.env, { RESEND_API_KEY: "test-not-a-key", EMAIL_FROM: "noreply@example.org", EMAIL_REPLY_TO: "noreply@example.org", APP_URL: `http://localhost:${port}` });
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).startsWith("https://api.resend.com")) {
      if (/invitation/i.test(String(init?.body ?? ""))) invitations += 1;
      return new Response(JSON.stringify({ id: randomUUID() }), { status: 200 });
    }
    return realFetch(url, init);
  }) as typeof fetch;
  try {
    return { result: await fn(), invitations };
  } finally {
    globalThis.fetch = realFetch;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

for (const [locale, messages] of [["fr-CA", fr], ["en-CA", en]] as const) {
  test(`routine case from submission to closure with no case manager (${locale})`, async ({ browser }) => {
    test.setTimeout(180_000);
    if (!(await prisma.user.findFirst({ where: { globalRole: "CASE_AGENT" } }))) {
      await prisma.user.create({ data: { email: `case-agent-${randomUUID()}@aequitas.invalid`, displayName: "Automated assistant", globalRole: "CASE_AGENT" } });
    }
    const mk = (label: string, globalRole: "COMPLAINANT" | "RESPONDENT") =>
      prisma.user.create({ data: { email: `routine-e2e-${label}-${randomUUID()}@example.org`, displayName: `Routine ${label} ${locale}`, globalRole, locale } });
    const [c, r] = await Promise.all([mk("c", "COMPLAINANT"), mk("r", "RESPONDENT")]);
    const statement = await prisma.consentStatementVersion.create({ data: { version: Number.parseInt(randomUUID().replaceAll("-", "").slice(0, 8), 16) % 2_000_000_000, locale, body: "Synthetic consent.", effectiveFrom: new Date() } });
    const created = await createCase({ actorId: c.id, actorRole: "COMPLAINANT", referenceNumber: `AE-ROUTINE-${randomUUID().slice(0, 8)}`, complainantId: c.id, respondentId: r.id, simulated: true, category: "RETAIL", amountAtStakeCents: 8999, disputeDescription: "Synthetic kettle dispute.", requestedStatementVersionId: statement.id, currentStatementVersionId: statement.id });
    if (!created.ok) throw new Error(created.reason);
    const caseId = created.data.caseId;
    expect((await submitCase({ actorId: c.id, actorRole: "COMPLAINANT", caseId })).ok).toBe(true);

    // The agent takes the case and invites the respondent.
    const { invitations } = await withInterceptedEmail(async () => {
      expect((await runCaseAgent({ caseId, model: NO_CALL_MODEL, env: ENV })).status).toBe("intake_opened");
      expect((await runCaseAgent({ caseId, model: NO_CALL_MODEL, env: ENV })).status).toBe("respondent_invited");
      expect((await runCaseAgent({ caseId, model: NO_CALL_MODEL, env: ENV })).status).toBe("waiting");
    });
    expect(invitations).toBe(1);
    // Stand-in for the respondent completing passkey enrolment from the invitation.
    await prisma.webAuthnCredential.create({ data: { userId: r.id, credentialId: randomUUID(), publicKey: Buffer.from("synthetic"), counter: 0n, transports: [] } });

    const [cc, rc] = await Promise.all([contextFor(browser, c.id, "COMPLAINANT"), contextFor(browser, r.id, "RESPONDENT")]);
    const [cp, rp] = await Promise.all([cc.newPage(), rc.newPage()]);
    const texts = { [c.id]: "Receipt 4471: kettle bought 2026-10-02 for $89.99, paid by debit card.", [r.id]: "Store log: customer offered a repair voucher at the counter on 2026-10-06." };
    for (const [page, party] of [[cp, c], [rp, r]] as const) {
      await page.goto(`/${locale}/cases/${caseId}`);
      await expect(page.locator("#case-agent-notice")).toHaveText(messages.workspace.caseAgent.partyNotice);
      await page.waitForLoadState("networkidle");
      await page.fill("#evidence-title", `Evidence ${party.globalRole}`);
      await page.setInputFiles("#evidence-file", { name: "evidence.txt", mimeType: "text/plain", buffer: Buffer.from(texts[party.id]) });
      await page.getByRole("button", { name: messages.workspace.evidence.form.submit, exact: true }).click();
      await expect(page.locator("#evidence-heading ~ ul li")).toHaveCount(1);
    }
    await expect.poll(async () => prisma.evidenceItem.count({ where: { caseId, scanStatus: "CLEAN" } })).toBe(2);

    for (const page of [cp, rp]) {
      const intake = page.locator('section[aria-labelledby="intake-ready-heading"]');
      await page.getByRole("button", { name: messages.workspace.caseAgent.intakeReadyMark, exact: true }).click();
      await expect(intake.getByRole("status")).toHaveText(messages.workspace.caseAgent.intakeReadyMarked);
    }

    // Each party explicitly marks their own evidence complete; the agent closes intake.
    expect((await runCaseAgent({ caseId, model: NO_CALL_MODEL, env: ENV })).status).toBe("intake_closed");
    for (const page of [cp, rp]) {
      await page.reload();
      await page.waitForLoadState("networkidle");
      await page.fill("#position-body", "Synthetic position for the routine journey.");
      await page.getByRole("button", { name: messages.workspace.positions.form.submit, exact: true }).click();
      await expect(page.locator("#positions-heading ~ ul li")).toHaveCount(1);
    }

    // The agent waits before it extracts evidence or calls the provider.
    expect((await runCaseAgent({ caseId, model: NO_CALL_MODEL, env: ENV })).status).toBe("waiting");
    for (const page of [cp, rp]) {
      await page.reload();
      await expect(page.locator("#case-agent-processing-choice")).toBeVisible();
      await expect(page.locator("#case-agent-processing-choice")).toContainText("synthetic-e2e-project");
      await expect(page.locator("#case-agent-processing-choice")).toContainText("gemini-3.8-flash");
      const notice = locale === "fr-CA" ? ENV.AEQUITAS_CASE_AGENT_PROCESSING_NOTICE_FR : ENV.AEQUITAS_CASE_AGENT_PROCESSING_NOTICE_EN;
      await expect(page.locator("#case-agent-processing-choice blockquote")).toHaveText(notice);
      const accepted = page.waitForResponse((res) => new URL(res.url()).pathname === `/api/cases/${caseId}/processing-choice` && res.request().method() === "POST");
      await page.locator("#accept-agent-processing").click();
      expect((await accepted).ok()).toBe(true);
      await expect(page.locator("#case-agent-processing-choice [role=status]")).toHaveText(messages.workspace.caseAgent.processingAccepted);
    }

    const evidence = await prisma.evidenceItem.findMany({ where: { caseId } });
    const idOf = (partyId: string) => evidence.find((e) => e.submittedById === partyId)!.id;
    const model = { provider: "test", model: "stub", complete: async (prompt: string) => {
      expect(prompt).toContain(texts[c.id]);
      return JSON.stringify({
        needs_human: null,
        summary_claims: [{ text: "The buyer's file records the purchase.", citation_ids: ["C1"] }, { text: "The seller's file records a repair offer.", citation_ids: ["C2"] }],
        reasoning_claims: [{ text: "Both files record parts of the exchange.", citation_ids: ["C1", "C2"] }],
        limits: ["The kettle was not examined."], not_considered: ["Other losses."],
        citations: [
          { citation_id: "C1", evidence_item_id: idOf(c.id), relevance: "Purchase record.", excerpt: "kettle bought 2026-10-02 for $89.99" },
          { citation_id: "C2", evidence_item_id: idOf(r.id), relevance: "Remedy offered.", excerpt: "offered a repair voucher at the counter" },
        ],
        proposal: { remedy: "refund_partial", amount_cents: 4500 },
        party_evidence: { complainant: [idOf(c.id)], respondent: [idOf(r.id)] },
      });
    } };
    expect((await runCaseAgent({ caseId, model, env: ENV })).status).toBe("issued");

    for (const [page, party] of [[cp, c], [rp, r]] as const) {
      const outcome = await prisma.partyOutcome.findFirstOrThrow({ where: { caseId, partyId: party.id, status: "ISSUED" } });
      await page.reload();
      await expect(page.locator("#your-outcome")).toHaveText(outcome.body);
      expect(await page.content()).not.toContain("Staff-only summary");
      await page.waitForLoadState("networkidle");
      const answered = page.waitForResponse((res) => new URL(res.url()).pathname === `/api/cases/${caseId}/consent` && res.request().method() === "POST");
      await page.locator("#give-consent").click();
      expect((await answered).ok()).toBe(true);
    }
    expect(await prisma.partyOutcome.findFirstOrThrow({ where: { caseId, partyId: c.id } }).then((o) => o.body)).toContain(locale === "fr-CA" ? "45,00" : "$45.00");
    await expect.poll(async () => (await prisma.case.findUniqueOrThrow({ where: { id: caseId } })).state).toBe("RESOLVED_CONSENT");

    expect((await runCaseAgent({ caseId, model, env: ENV })).status).toBe("closed");
    const row = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
    expect(row).toMatchObject({ state: "CLOSED", caseManagerId: null, agentEscalatedAt: null });
    expect(await verifyCase(prisma, row)).toEqual([]);
    await cp.reload();
    await expect(cp.getByText(messages.workspace.state.CLOSED, { exact: true }).first()).toBeVisible();
    await Promise.all([cc.close(), rc.close()]);
  });
}
