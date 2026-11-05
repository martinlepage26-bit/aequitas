import "../src/lib/loadEnv";
import { createHash, randomUUID } from "node:crypto";
import { test, expect, type Browser, type BrowserContext } from "@playwright/test";
import { prisma } from "../src/lib/prisma";
import { signPayload } from "../src/lib/signedCookie";
import { SESSION_COOKIE } from "../src/lib/session";
import { closeIntake, createCase, openIntake, submitCase, submitPosition } from "../src/domain/mutate";
import { verifyCase } from "../src/domain/verifyEvents";
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
    const [complainant, respondent, manager, otherManager, approver] = await Promise.all([
      mk("c", "COMPLAINANT"), mk("r", "RESPONDENT"), mk("m", "CASE_MANAGER"), mk("om", "CASE_MANAGER"), mk("ap", "CASE_MANAGER"),
    ]);
    await prisma.user.update({ where: { id: approver.id }, data: { isApprover: true } });
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
    const evidenceIds: string[] = [];
    for (const party of [complainant, respondent]) {
      const body = Buffer.from(`synthetic ${party.id}`);
      evidenceIds.push((await prisma.evidenceItem.create({ data: {
        caseId, submittedById: party.id, kind: "DOCUMENT", title: `Synthetic file ${party.globalRole}`,
        storageKey: `simulated/e2e/${randomUUID()}`, sha256: createHash("sha256").update(body).digest("hex"),
        byteSize: body.byteLength, mimeType: "text/plain", scanStatus: "CLEAN", simulated: true,
      } })).id);
    }
    if (!(await closeIntake({ actorId: manager.id, actorRole: "CASE_MANAGER", caseId })).ok) throw new Error("close intake failed");
    if (!(await submitPosition({ actorId: complainant.id, actorRole: "COMPLAINANT", caseId, body: "Position A.", locale })).ok) throw new Error("position failed");
    if (!(await submitPosition({ actorId: respondent.id, actorRole: "RESPONDENT", caseId, body: "Position B.", locale })).ok) throw new Error("position failed");

    const copy = messages.workspace.authorDraft;
    const summary = locale === "fr-CA" ? "Le colis est arrivé en retard; la cause est contestée." : "The parcel arrived late; the cause is disputed.";

    // Refusals over HTTP: a party and an unassigned manager cannot write a draft.
    const partyContext = await contextFor(browser, complainant.id, "COMPLAINANT");
    const otherContext = await contextFor(browser, otherManager.id, "CASE_MANAGER");
    const draftBody = { explanation: { summary, proposed_outcome: "x", reasoning: "y", limits: ["l"], not_considered: ["n"], evidence_citations: [{ evidence_item_id: evidenceIds[0], relevance: "r" }] } };
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
    // At least one citation is required; the form says so before calling the server.
    await page.getByRole("button", { name: copy.save }).click();
    await expect(page.getByText(copy.citationRequired)).toBeVisible();
    await page.getByLabel("Synthetic file COMPLAINANT").check();
    await page.locator(`#author-draft-relevance-${evidenceIds[0]}`).fill(locale === "fr-CA" ? "Montre la date promise." : "Shows the promised date.");
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

    // The shared text may draw on both sides, so the party's copy withholds
    // it and says so; their own outcome (below) is what they answer.
    await partyPage.reload();
    await expect(partyPage.locator("#recommendation-withheld")).toHaveText(messages.workspace.recommendation.withheldForParty);
    expect(await partyPage.content()).not.toContain(summary);
    await expect(partyPage.getByText(messages.workspace.recommendation.humanAuthoredLabel)).toBeVisible();
    await expect(partyPage.getByText(copy.title)).toHaveCount(0);

    // Per-party outcomes: each party sees only their own issued text.
    const outcomeText = { [complainant.id]: `COMPLAINANT-OUTCOME-${locale}-${randomUUID()}`, [respondent.id]: `RESPONDENT-OUTCOME-${locale}-${randomUUID()}` };
    for (const party of [complainant, respondent]) {
      await page.reload();
      await page.locator(`#party-outcome-body-${party.id}`).fill(outcomeText[party.id]);
      const outcomeIssued = page.waitForResponse(r => new URL(r.url()).pathname === `/api/cases/${caseId}/party-outcomes` && r.request().method() === "POST");
      await page.locator(`#party-outcome-issue-${party.id}`).click();
      expect((await outcomeIssued).ok()).toBe(true);
    }
    const respondentContext = await contextFor(browser, respondent.id, "RESPONDENT");
    const respondentPage = await respondentContext.newPage();
    await partyPage.reload();
    await respondentPage.goto(`/${locale}/cases/${caseId}`);
    await expect(partyPage.locator("#your-outcome")).toHaveText(outcomeText[complainant.id]);
    expect(await partyPage.content()).not.toContain(outcomeText[respondent.id]);
    await expect(respondentPage.locator("#your-outcome")).toHaveText(outcomeText[respondent.id]);
    expect(await respondentPage.content()).not.toContain(outcomeText[complainant.id]);

    // Consent is refused until a separate approver signs off; the case manager cannot approve.
    const consented = (p: typeof page) => p.waitForResponse(r => new URL(r.url()).pathname === `/api/cases/${caseId}/consent` && r.request().method() === "POST");
    let response = consented(partyPage);
    await partyPage.locator("#give-consent").click();
    expect((await response).status()).toBe(409);
    await page.reload();
    await expect(page.locator("#approve-resolution")).toHaveCount(0);
    expect((await managerContext.request.post(`/api/cases/${caseId}/approval`, { data: { rationale: "self" } })).ok()).toBe(false);
    const approverContext = await contextFor(browser, approver.id, "CASE_MANAGER");
    const approverPage = await approverContext.newPage();
    await approverPage.goto(`/${locale}/cases/${caseId}`);
    await approverPage.locator("#approval-rationale").fill(locale === "fr-CA" ? "Dossier et raisonnement relus." : "Record and reasoning reviewed.");
    const approved = approverPage.waitForResponse(r => new URL(r.url()).pathname === `/api/cases/${caseId}/approval`);
    await approverPage.locator("#approve-resolution").click();
    expect((await approved).ok()).toBe(true);

    for (const p of [partyPage, respondentPage]) {
      await p.reload();
      response = consented(p);
      await p.locator("#give-consent").click();
      expect((await response).ok()).toBe(true);
    }
    await expect.poll(async () => (await prisma.case.findUniqueOrThrow({ where: { id: caseId } })).state).toBe("RESOLVED_CONSENT");

    // Export is the assigned manager's; closing seals it.
    expect((await otherContext.request.get(`/api/cases/${caseId}/export`)).ok()).toBe(false);
    const exported = await managerContext.request.get(`/api/cases/${caseId}/export`);
    expect(exported.ok()).toBe(true);
    await page.reload();
    const closed = page.waitForResponse(r => new URL(r.url()).pathname === `/api/cases/${caseId}/close`);
    await page.getByRole("button", { name: messages.workspace.close.closeButton }).click();
    expect((await closed).ok()).toBe(true);
    const finalRow = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
    expect(finalRow.state).toBe("CLOSED");
    expect(await verifyCase(prisma, finalRow)).toEqual([]);

    await Promise.all([partyContext.close(), otherContext.close(), managerContext.close(), respondentContext.close(), approverContext.close()]);
  });
}
