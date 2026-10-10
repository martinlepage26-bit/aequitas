import "../src/lib/loadEnv";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { test, expect, type Browser, type BrowserContext } from "@playwright/test";
import { prisma } from "../src/lib/prisma";
import { signPayload } from "../src/lib/signedCookie";
import { SESSION_COOKIE } from "../src/lib/session";
import { createCase, openIntake, submitCase } from "../src/domain/mutate";
import fr from "../messages/fr-CA.json";
import en from "../messages/en-CA.json";

const ARTIFACTS = "/opt/cursor/artifacts";

function cookieFor(userId: string, globalRole: string): string {
  return signPayload({ purpose: "session", userId, globalRole, authMethod: "dev-bypass" }, 60 * 60);
}

async function contextFor(browser: Browser, userId: string, globalRole: string): Promise<BrowserContext> {
  const context = await browser.newContext();
  await context.addCookies([{
    name: SESSION_COOKIE,
    value: cookieFor(userId, globalRole),
    url: `http://localhost:${process.env.PLAYWRIGHT_PORT ?? 3000}`,
  }]);
  return context;
}

for (const [locale, messages] of [["fr-CA", fr], ["en-CA", en]] as const) {
  test(`provenance click shows the excerpt in ${locale}`, async ({ browser }) => {
    test.setTimeout(120_000);
    mkdirSync(ARTIFACTS, { recursive: true });
    const suffix = locale === "fr-CA" ? "fr" : "en";
    const complainant = await prisma.user.create({
      data: { email: `prov-c-${randomUUID()}@example.com`, displayName: `Prov Complainant ${suffix}`, globalRole: "COMPLAINANT", locale },
    });
    const respondent = await prisma.user.create({
      data: { email: `prov-r-${randomUUID()}@example.com`, displayName: `Prov Respondent ${suffix}`, globalRole: "RESPONDENT", locale },
    });
    const manager = await prisma.user.create({
      data: { email: `prov-m-${randomUUID()}@example.com`, displayName: `Prov Manager ${suffix}`, globalRole: "CASE_MANAGER", locale },
    });
    const statement = await prisma.consentStatementVersion.create({
      data: {
        version: Number.parseInt(randomUUID().replaceAll("-", "").slice(0, 8), 16) % 2_000_000_000,
        locale,
        body: `Provenance e2e consent (${locale}).`,
        effectiveFrom: new Date(),
      },
    });
    const created = await createCase({
      actorId: complainant.id,
      actorRole: "COMPLAINANT",
      referenceNumber: `AE-PROV-${randomUUID()}`,
      complainantId: complainant.id,
      respondentId: respondent.id,
      disputeDescription: "The delivery note and the invoice name different dates.",
      simulated: true,
      requestedStatementVersionId: statement.id,
      currentStatementVersionId: statement.id,
    });
    if (!created.ok) throw new Error(created.reason);
    const caseId = created.data.caseId;
    if (!(await submitCase({ actorId: complainant.id, actorRole: "COMPLAINANT", caseId })).ok) throw new Error("submit failed");
    if (!(await openIntake({ actorId: manager.id, actorRole: "CASE_MANAGER", caseId, hasConflict: false })).ok) throw new Error("intake failed");

    const claimText = locale === "fr-CA"
      ? "Le bon de livraison et la facture ne nomment pas la même date."
      : "The delivery note and the invoice do not name the same date.";
    const excerpt = locale === "fr-CA"
      ? "Laissé à la porte le 2 mars; la facture dit le 4 mars."
      : "Left at the door on 2 March; the invoice says 4 March.";
    const copy = messages.workspace.claims;

    const managerContext = await contextFor(browser, manager.id, "CASE_MANAGER");
    const partyContext = await contextFor(browser, complainant.id, "COMPLAINANT");
    const managerPage = await managerContext.newPage();
    await managerPage.goto(`/${locale}/cases/${caseId}`);
    // Same gap as the sign-in form: the source form is in the server HTML
    // before React hydrates, and a click in that gap submits the page
    // instead of the fetch handler.
    await managerPage.locator("#claim-source-title").waitFor();
    await managerPage.waitForFunction(() => {
      const input = document.querySelector("#claim-source-title");
      return !!input && Object.keys(input).some((key) => key.startsWith("__reactFiber$"));
    });
    await managerPage.selectOption("#claim-source-kind", "STATUTE");
    await managerPage.fill("#claim-source-title", `Civil Code note ${suffix}`);
    await managerPage.fill("#claim-source-citation", "C.C.Q. art. 1457");
    await managerPage.fill("#claim-source-framework", "Code civil du Québec");
    await managerPage.getByRole("button", { name: copy.form.saveSource, exact: true }).click();
    await expect(managerPage.locator("#link-source")).toContainText(`Civil Code note ${suffix}`);

    await managerPage.selectOption("#claim-type", "FACTUAL");
    await managerPage.fill("#claim-text", claimText);
    await managerPage.selectOption("#claim-confidence", "UNKNOWN");
    await managerPage.fill("#claim-rationale", locale === "fr-CA" ? "La seconde pièce n'est pas encore citée." : "The second record is not cited yet.");
    await managerPage.getByRole("button", { name: copy.form.saveClaim, exact: true }).click();
    await expect(managerPage.locator("#link-claim")).toContainText(claimText.slice(0, 40));

    await managerPage.fill("#link-excerpt", excerpt);
    await managerPage.getByRole("button", { name: copy.form.saveLink, exact: true }).click();

    const panel = managerPage.locator("[data-claims-panel]");
    await expect(panel.getByText(claimText)).toBeVisible();
    await expect(panel.getByText(excerpt)).toBeHidden();
    await panel.screenshot({ path: `${ARTIFACTS}/claims-panel-${suffix}.png` });
    await panel.getByText(copy.why, { exact: true }).click();
    await expect(panel.getByText(excerpt)).toBeVisible();
    await expect(panel.getByText(`Civil Code note ${suffix}`)).toBeVisible();
    await expect(panel.getByText(manager.displayName)).toHaveCount(2);
    await expect(panel.getByText("C.C.Q. art. 1457")).toBeVisible();
    await panel.screenshot({ path: `${ARTIFACTS}/claims-provenance-${suffix}.png` });

    const partyPage = await partyContext.newPage();
    await partyPage.goto(`/${locale}/cases/${caseId}`);
    await expect(partyPage.getByRole("button", { name: copy.form.saveSource, exact: true })).toHaveCount(0);
    const partyPanel = partyPage.locator("[data-claims-panel]");
    await partyPanel.getByText(copy.why, { exact: true }).click();
    await expect(partyPanel.getByText(excerpt)).toBeVisible();
    await expect(partyPanel.getByText(manager.displayName)).toHaveCount(2);
    await managerContext.close();
    await partyContext.close();
  });
}
