import "../src/lib/loadEnv";
import { randomUUID } from "node:crypto";
import { test, expect, type Browser, type BrowserContext } from "@playwright/test";
import { prisma } from "../src/lib/prisma";
import { signPayload } from "../src/lib/signedCookie";
import { SESSION_COOKIE } from "../src/lib/session";
import fr from "../messages/fr-CA.json";
import en from "../messages/en-CA.json";
import type { GlobalRole } from "../src/generated/prisma";

async function contextFor(browser: Browser, userId: string, globalRole: GlobalRole, baseURL: string): Promise<BrowserContext> {
  const context = await browser.newContext({ baseURL });
  await context.addCookies([{ name: SESSION_COOKIE, value: signPayload({ purpose: "session", userId, globalRole, authMethod: "dev-bypass" }, 3600), url: baseURL }]);
  return context;
}

for (const [locale, messages] of [["fr-CA", fr], ["en-CA", en]] as const) {
  test(`a party sees only their issued outcome before consent (${locale})`, async ({ browser, baseURL }) => {
    if (!baseURL) throw new Error("Missing test base URL");
    const copy = messages.workspace.partyOutcome;
    const user = (role: GlobalRole, name: string) => prisma.user.create({
      data: { email: `outcome-e2e-${randomUUID()}@example.com`, displayName: name, globalRole: role, locale },
    });
    const [complainant, respondent, manager] = await Promise.all([
      user("COMPLAINANT", `Complainant ${locale}`),
      user("RESPONDENT", `Respondent ${locale}`),
      user("CASE_MANAGER", `Mediator ${locale}`),
    ]);
    const statement = await prisma.consentStatementVersion.create({
      data: { version: Number.parseInt(randomUUID().replaceAll("-", "").slice(0, 8), 16) % 2_000_000_000, locale, body: "Synthetic outcome test.", effectiveFrom: new Date() },
    });
    const caseRow = await prisma.case.create({
      data: {
        referenceNumber: `AE-OUTCOME-E2E-${randomUUID().slice(0, 8)}`,
        state: "ISSUED",
        simulated: true,
        consentOnlyResolution: true,
        disputeDescription: "The other party did not do what we agreed.",
        complainantId: complainant.id,
        respondentId: respondent.id,
        caseManagerId: manager.id,
      },
    });
    const recommendation = await prisma.recommendation.create({
      data: {
        caseId: caseRow.id,
        version: 1,
        status: "ISSUED",
        explanation: { summary: "Summary.", proposed_outcome: "Proposed outcome.", reasoning: "Reasoning.", evidence_citations: [], limits: [], not_considered: [], model: { id: "test", prompt_version: "test" }, reviewer: { user_id: manager.id, issued_at: new Date().toISOString() } },
        modelId: "test",
        promptVersion: "test",
        issuedById: manager.id,
        issuedAt: new Date(),
      },
    });
    await prisma.case.update({ where: { id: caseRow.id }, data: { currentRecommendationId: recommendation.id } });

    const complainantOutcome = `COMPLAINANT-OUTCOME-${locale}-${randomUUID()}`;
    const respondentDraft = `RESPONDENT-DRAFT-${locale}-${randomUUID()}`;
    const respondentOutcome = `RESPONDENT-OUTCOME-${locale}-${randomUUID()}`;
    const managerContext = await contextFor(browser, manager.id, "CASE_MANAGER", baseURL);
    const complainantContext = await contextFor(browser, complainant.id, "COMPLAINANT", baseURL);
    const respondentContext = await contextFor(browser, respondent.id, "RESPONDENT", baseURL);

    const managerPage = await managerContext.newPage();
    await managerPage.goto(`/${locale}/cases/${caseRow.id}`);
    await expect(managerPage.getByRole("heading", { name: copy.title, exact: true })).toBeVisible();
    await expect(managerPage.getByText(messages.workspace.partyOutcomeNotice.replaceAll("{name}", complainant.displayName), { exact: true })).toBeVisible();
    await managerPage.locator(`#party-outcome-body-${complainant.id}`).fill(complainantOutcome);
    const issued = managerPage.waitForResponse(
      (response) => response.request().method() === "POST" && new URL(response.url()).pathname === `/api/cases/${caseRow.id}/party-outcomes`,
    );
    await managerPage.locator(`#party-outcome-issue-${complainant.id}`).click();
    expect((await issued).ok()).toBe(true);

    await managerPage.locator(`#party-outcome-body-${respondent.id}`).fill(respondentDraft);
    const drafted = managerPage.waitForResponse(
      (response) => response.request().method() === "POST" && new URL(response.url()).pathname === `/api/cases/${caseRow.id}/party-outcomes`,
    );
    await managerPage.locator(`#party-outcome-save-${respondent.id}`).click();
    expect((await drafted).ok()).toBe(true);

    const complainantPage = await complainantContext.newPage();
    await complainantPage.goto(`/${locale}/cases/${caseRow.id}`);
    await expect(complainantPage.locator("#your-outcome")).toHaveText(complainantOutcome);
    await expect(complainantPage.locator("#give-consent")).toBeEnabled();
    await expect(complainantPage.locator("#decline-consent")).toBeEnabled();
    expect(await complainantPage.content()).not.toContain(respondentDraft);

    const respondentPage = await respondentContext.newPage();
    await respondentPage.goto(`/${locale}/cases/${caseRow.id}`);
    await expect(respondentPage.locator("#outcome-unavailable")).toHaveText(messages.workspace.consent.outcomeUnavailable);
    await expect(respondentPage.locator("#give-consent")).toBeDisabled();
    await expect(respondentPage.locator("#decline-consent")).toBeDisabled();
    expect(await respondentPage.content()).not.toContain(complainantOutcome);
    expect(await respondentPage.content()).not.toContain(respondentDraft);

    await managerPage.locator(`#party-outcome-body-${respondent.id}`).fill(respondentOutcome);
    const respondentIssued = managerPage.waitForResponse(
      (response) => response.request().method() === "POST" && new URL(response.url()).pathname === `/api/cases/${caseRow.id}/party-outcomes`,
    );
    await managerPage.locator(`#party-outcome-issue-${respondent.id}`).click();
    expect((await respondentIssued).ok()).toBe(true);
    await respondentPage.reload();
    await expect(respondentPage.locator("#your-outcome")).toHaveText(respondentOutcome);
    await expect(respondentPage.locator("#give-consent")).toBeEnabled();
    expect(await respondentPage.content()).not.toContain(complainantOutcome);

    const declined = complainantPage.waitForResponse(
      (response) => response.request().method() === "POST" && new URL(response.url()).pathname === `/api/cases/${caseRow.id}/consent`,
    );
    await complainantPage.locator("#decline-consent").click();
    expect((await declined).ok()).toBe(true);
    await expect(complainantPage.getByText(messages.workspace.state.RESOLVED_DECLINED, { exact: true })).toBeVisible();
  });
}
