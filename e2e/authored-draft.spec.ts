import "../src/lib/loadEnv";
import { createHash, randomUUID } from "node:crypto";
import { test, expect, type Browser, type BrowserContext } from "@playwright/test";
import { prisma } from "../src/lib/prisma";
import { signPayload } from "../src/lib/signedCookie";
import { SESSION_COOKIE } from "../src/lib/session";
import { closeIntake, createCase, openIntake, submitCase, submitPosition } from "../src/domain/mutate";
import fr from "../messages/fr-CA.json";
import en from "../messages/en-CA.json";

// A case manager writes and issues a recommendation with no model
// configured; the parties then see it labelled as human-written. Synthetic
// data only. Evidence rows are seeded as already scanned, because this spec
// is about drafting, not ClamAV.

const port = process.env.PLAYWRIGHT_PORT ?? 3000;

async function contextFor(browser: Browser, userId: string, globalRole: string): Promise<BrowserContext> {
  const context = await browser.newContext();
  await context.addCookies([{
    name: SESSION_COOKIE,
    value: signPayload({ purpose: "session", userId, globalRole, authMethod: "dev-bypass" }, 60 * 60),
    url: `http://localhost:${port}`,
  }]);
  return context;
}

for (const [locale, messages] of [["fr-CA", fr], ["en-CA", en]] as const) {
  test(`a case manager writes and issues a draft without a model in ${locale}`, async ({ browser }) => {
    test.setTimeout(120_000);
    const mk = (label: string, globalRole: "COMPLAINANT" | "RESPONDENT" | "CASE_MANAGER") =>
      prisma.user.create({ data: { email: `authored-e2e-${label}-${randomUUID()}@example.com`, displayName: `Authored ${label} ${locale}`, globalRole, locale } });
    const [complainant, respondent, manager, otherManager] = await Promise.all([
      mk("c", "COMPLAINANT"), mk("r", "RESPONDENT"), mk("m", "CASE_MANAGER"), mk("om", "CASE_MANAGER"),
    ]);
    const statement = await prisma.consentStatementVersion.create({
      data: { version: Number.parseInt(randomUUID().replaceAll("-", "").slice(0, 8), 16) % 2_000_000_000, locale, body: `Synthetic consent (${locale}).`, effectiveFrom: new Date() },
    });
    const created = await createCase({
      actorId: complainant.id, actorRole: "COMPLAINANT", referenceNumber: `AE-AUTHE2E-${randomUUID().slice(0, 8)}`,
      complainantId: complainant.id, respondentId: respondent.id, simulated: true,
      disputeDescription: "Synthetic late-delivery dispute.",
      requestedStatementVersionId: statement.id, currentStatementVersionId: statement.id,
    });
    if (!created.ok) throw new Error(created.reason);
    const caseId = created.data.caseId;
    if (!(await submitCase({ actorId: complainant.id, actorRole: "COMPLAINANT", caseId })).ok) throw new Error("submit failed");
    if (!(await openIntake({ actorId: manager.id, actorRole: "CASE_MANAGER", caseId, hasConflict: false })).ok) throw new Error("intake failed");
    for (const party of [complainant, respondent]) {
      const body = Buffer.from(`synthetic ${party.id}`);
      await prisma.evidenceItem.create({ data: {
        caseId, submittedById: party.id, kind: "DOCUMENT", title: `Synthetic file ${party.globalRole}`,
        storageKey: `simulated/e2e/${randomUUID()}`, sha256: createHash("sha256").update(body).digest("hex"),
        byteSize: body.byteLength, mimeType: "text/plain", scanStatus: "CLEAN", simulated: true,
      } });
    }
    if (!(await closeIntake({ actorId: manager.id, actorRole: "CASE_MANAGER", caseId })).ok) throw new Error("close intake failed");
    if (!(await submitPosition({ actorId: complainant.id, actorRole: "COMPLAINANT", caseId, body: "Position A.", locale })).ok) throw new Error("position failed");
    if (!(await submitPosition({ actorId: respondent.id, actorRole: "RESPONDENT", caseId, body: "Position B.", locale })).ok) throw new Error("position failed");

    const copy = messages.workspace.authorDraft;
    const summary = locale === "fr-CA" ? "Le colis est arrivé en retard; la cause est contestée." : "The parcel arrived late; the cause is disputed.";

    // Refusals over HTTP: a party and an unassigned manager cannot write a draft.
    const partyContext = await contextFor(browser, complainant.id, "COMPLAINANT");
    const otherContext = await contextFor(browser, otherManager.id, "CASE_MANAGER");
    const draftBody = { explanation: { summary, proposed_outcome: "x", reasoning: "y", limits: ["l"], not_considered: ["n"], evidence_citations: [] } };
    expect((await partyContext.request.post(`/api/cases/${caseId}/authored-draft`, { data: draftBody })).status()).toBe(403);
    expect((await otherContext.request.post(`/api/cases/${caseId}/authored-draft`, { data: draftBody })).status()).toBe(404);

    const partyPage = await partyContext.newPage();
    await partyPage.goto(`/${locale}/cases/${caseId}`);
    await expect(partyPage.getByText(copy.title)).toHaveCount(0);

    const managerContext = await contextFor(browser, manager.id, "CASE_MANAGER");
    const page = await managerContext.newPage();
    await page.goto(`/${locale}/cases/${caseId}`);
    await expect(page.getByText(copy.title)).toBeVisible();
    await page.waitForLoadState("networkidle");
    await page.getByLabel(copy.summaryLabel).fill(summary);
    await page.getByLabel(copy.proposedOutcomeLabel).fill(locale === "fr-CA" ? "Remboursement des frais de livraison." : "Refund of the shipping fee.");
    await page.getByLabel(copy.reasoningLabel).fill(locale === "fr-CA" ? "Les deux positions confirment le retard." : "Both positions confirm the delay.");
    await page.getByLabel(copy.limitsLabel).fill(locale === "fr-CA" ? "Les registres du transporteur manquent." : "Carrier records are missing.");
    await page.getByLabel(copy.notConsideredLabel).fill(locale === "fr-CA" ? "Toute autre perte." : "Any other loss.");
    const saved = page.waitForResponse(r => r.url().endsWith(`/api/cases/${caseId}/authored-draft`) && r.request().method() === "POST");
    await page.getByRole("button", { name: copy.save }).click();
    expect((await saved).status()).toBe(200);
    await expect(page.getByText(messages.workspace.recommendation.humanAuthoredLabel)).toBeVisible();

    // The draft stays with the manager until issued.
    await partyPage.reload();
    await expect(partyPage.getByText(summary)).toHaveCount(0);

    const checklist = messages.workspace.recommendation.checklist;
    await page.getByLabel(checklist.reviewedEvidence).check();
    await page.getByLabel(checklist.confirmedLimits).check();
    await page.getByLabel(checklist.acceptsResponsibility).check();
    const issued = page.waitForResponse(r => r.url().includes("/issue") && r.request().method() === "POST");
    await page.getByRole("button", { name: messages.workspace.recommendation.issueButton }).click();
    expect((await issued).status()).toBe(200);
    await expect.poll(async () => (await prisma.case.findUniqueOrThrow({ where: { id: caseId } })).state).toBe("ISSUED");

    await partyPage.reload();
    await expect(partyPage.getByText(summary)).toBeVisible();
    await expect(partyPage.getByText(messages.workspace.recommendation.humanAuthoredLabel)).toBeVisible();
    await expect(partyPage.getByText(copy.title)).toHaveCount(0);

    await Promise.all([partyContext.close(), otherContext.close(), managerContext.close()]);
  });
}
