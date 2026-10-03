import "../src/lib/loadEnv";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test, expect, type Browser, type BrowserContext } from "@playwright/test";
import { prisma } from "../src/lib/prisma";
import { signPayload } from "../src/lib/signedCookie";
import { SESSION_COOKIE } from "../src/lib/session";
import { createCase, submitCase, openIntake } from "../src/domain/mutate";
import fr from "../messages/fr-CA.json";
import en from "../messages/en-CA.json";
import type { GlobalRole } from "../src/generated/prisma";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const axeSource = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
async function contextFor(browser: Browser, userId: string, globalRole: GlobalRole, baseURL: string): Promise<BrowserContext> {
  const context = await browser.newContext({ baseURL });
  await context.addCookies([{ name: SESSION_COOKIE, value: signPayload({ userId, globalRole, authMethod: "dev-bypass" }, 3600), url: baseURL }]);
  return context;
}
for (const [locale, m] of [["fr-CA", fr], ["en-CA", en]] as const) {
  test(`public submission guidance and accessible themes (${locale})`, async ({ page }) => {
    await page.goto(`/${locale}`);
    await expect(page.getByRole("heading", { name: m.landing.submissions.title, exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: m.landing.signIn, exact: false })).toHaveAttribute("href", "/auth/sign-in");
    await page.addScriptTag({ content: axeSource });
    for (const [width, scheme] of [[1440, "light"], [390, "light"], [320, "light"], [1440, "dark"]] as const) {
      await page.setViewportSize({ width, height: 1000 }); await page.emulateMedia({ colorScheme: scheme });
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      const violations = await page.evaluate(async () => {
        const axe = (window as unknown as { axe: { run: (options: unknown) => Promise<{ violations: { id: string }[] }> } }).axe;
        return (await axe.run({ runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] } })).violations.map(v => v.id);
      });
      expect(violations, `${locale} ${scheme} ${width}px home accessibility`).toEqual([]);
    }
  });
  test(`evidence, chronology, positions and denied paths (${locale})`, async ({ browser, baseURL }) => {
    if (!baseURL) throw new Error("Missing test base URL");
    const user = (role: GlobalRole) => prisma.user.create({ data: { email: `submission-e2e-${randomUUID()}@example.com`, displayName: `Submission E2E ${role}`, globalRole: role, locale } });
    const [party, respondent, manager, outsider] = await Promise.all([user("COMPLAINANT"), user("RESPONDENT"), user("CASE_MANAGER"), user("COMPLAINANT")]);
    const statement = await prisma.consentStatementVersion.create({ data: { version: Number.parseInt(randomUUID().replaceAll("-", "").slice(0, 8), 16) % 2_000_000_000, locale, body: "Synthetic submission-flow test.", effectiveFrom: new Date() } });
    const created = await createCase({ actorId: party.id, actorRole: "COMPLAINANT", complainantId: party.id, respondentId: respondent.id,
      referenceNumber: `AE-SUBMISSION-E2E-${randomUUID()}`, simulated: true, requestedStatementVersionId: statement.id, currentStatementVersionId: statement.id });
    if (!created.ok) throw new Error("Fixture creation failed");
    const caseId = created.data.caseId;
    const partyContext = await contextFor(browser, party.id, "COMPLAINANT", baseURL);
    const managerContext = await contextFor(browser, manager.id, "CASE_MANAGER", baseURL);
    const outsiderContext = await contextFor(browser, outsider.id, "COMPLAINANT", baseURL);
    const respondentContext = await contextFor(browser, respondent.id, "RESPONDENT", baseURL);
    try {
      const page = await partyContext.newPage();
      const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
      await page.goto(`/${locale}/cases/${caseId}`);
      await expect(page.locator("#evidence-file")).toBeDisabled();
      await expect(page.locator("#chronology-date")).toBeDisabled();
      await expect(page.locator("#position-body")).toBeDisabled();
      await expect(page.locator("#evidence-guidance")).toHaveText(m.workspace.submission.availability.submitCaseFirst);
      await submitCase({ caseId, actorId: party.id, actorRole: "COMPLAINANT" });
      await openIntake({ caseId, actorId: manager.id, actorRole: "CASE_MANAGER", hasConflict: false });
      await page.reload();
      await expect(page.locator("#chronology-date")).toBeEnabled();
      await expect(page.locator("#position-body")).toBeDisabled();
      await page.getByRole("link", { name: m.workspace.submission.actions.chronology, exact: false }).click();
      await expect(page.locator("#chronology-heading")).toBeInViewport();
      await page.fill("#chronology-date", "2026-01-15");
      await page.fill("#chronology-title", "Invoice received");
      await page.fill("#chronology-description", "I received the invoice on this date.");
      await page.getByRole("button", { name: m.workspace.chronology.form.submit, exact: true }).click();
      await expect(page.locator("[id^=chronology-]").filter({ hasText: "Invoice received" }).first()).toBeVisible();
      await expect(page.locator("#chronology-title")).toHaveValue("");
      await expect(page.getByRole("status").filter({ hasText: m.workspace.chronology.form.success })).toBeVisible();
      // A lost connection must keep the user's draft and show a real error.
      await page.fill("#chronology-date", "2026-01-16"); await page.fill("#chronology-title", "Unsaved event"); await page.fill("#chronology-description", "Keep my draft.");
      await page.route(`**/api/cases/${caseId}/chronology`, route => route.abort());
      await page.getByRole("button", { name: m.workspace.chronology.form.submit, exact: true }).click();
      await expect(page.getByRole("alert").filter({ hasText: m.workspace.chronology.form.error })).toBeVisible();
      await expect(page.locator("#chronology-description")).toHaveValue("Keep my draft.");
      await page.unroute(`**/api/cases/${caseId}/chronology`);
      await page.fill("#evidence-title", "Invoice evidence");
      await page.setInputFiles("#evidence-file", { name: "invoice.png", mimeType: "image/png", buffer: PNG });
      await page.getByRole("button", { name: m.workspace.evidence.form.submit, exact: true }).click();
      await expect(page.locator("#evidence-heading ~ ul li")).toHaveCount(1);
      await expect(page.locator("#evidence-file")).toHaveValue("");
      const otherPage = await respondentContext.newPage(); await otherPage.goto(`/${locale}/cases/${caseId}`);
      await expect(otherPage.getByRole("heading", { name: "Invoice received" })).toBeVisible();
      await otherPage.fill("#evidence-title", "Respondent evidence"); await otherPage.setInputFiles("#evidence-file", { name: "reply.png", mimeType: "image/png", buffer: PNG });
      await otherPage.getByRole("button", { name: m.workspace.evidence.form.submit, exact: true }).click();
      await expect(otherPage.locator("#evidence-heading ~ ul li")).toHaveCount(2);
      const managerPage = await managerContext.newPage(); await managerPage.goto(`/${locale}/cases/${caseId}`);
      await expect(managerPage.locator("#chronology-date")).toBeDisabled();
      await managerPage.getByRole("button", { name: m.workspace.intake.closeButton, exact: true }).click();
      await expect(managerPage.locator("h1 + p strong")).toHaveText(m.workspace.state.POSITIONS);
      await page.reload(); await expect(page.locator("#chronology-date")).toBeDisabled(); await expect(page.locator("#evidence-file")).toBeDisabled();
      await expect(page.locator("#position-body")).toBeEnabled();
      await page.fill("#position-body", "My position refers to the dated invoice and uploaded evidence.");
      await page.getByRole("button", { name: m.workspace.positions.form.submit, exact: true }).click();
      await expect(page.locator("#positions-heading ~ ul li")).toHaveCount(1);
      await expect(page.getByRole("heading", { name: m.workspace.timeline.title, exact: true })).toBeVisible();
      const apiPath = `/api/cases/${caseId}/chronology`;
      const body = { occurredOn: "2026-01-01", title: "Test", description: "Test entry", locale };
      expect((await outsiderContext.request.get(apiPath)).status()).toBe(404);
      expect((await outsiderContext.request.post(apiPath, { data: body })).status()).toBe(404);
      expect((await managerContext.request.post(apiPath, { data: body })).status()).toBe(403);
      expect((await partyContext.request.post(apiPath, { data: body })).status()).toBe(409);
      expect((await partyContext.request.post(apiPath, { data: { ...body, occurredOn: "2026-02-31" } })).status()).toBe(400);
      const publicContext = await browser.newContext({ baseURL });
      expect((await publicContext.request.get(apiPath)).status()).toBe(401); await publicContext.close();
      await page.addScriptTag({ content: axeSource });
      for (const [name, width, scheme] of [["desktop", 1440, "light"], ["mobile", 390, "light"], ["small-mobile", 320, "light"], ["dark", 1440, "dark"]] as const) {
        await page.setViewportSize({ width, height: 1000 }); await page.emulateMedia({ colorScheme: scheme });
        await expect(page.getByRole("note")).toHaveCSS("color", "rgb(74, 59, 19)");
        expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
        await page.screenshot({ path: `/srv/workspaces/shared/aequitas-submissions-${locale}-${name}.png`, fullPage: true });
        const violations = await page.evaluate(async () => {
          const axe = (window as unknown as { axe: { run: (options: unknown) => Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }> } }).axe;
          const result = await axe.run({ runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] } });
          return result.violations.map(({ id, nodes }) => ({ id, targets: nodes.map(node => node.target) }));
        });
        expect(violations, `${locale} ${name} accessibility`).toEqual([]);
      }
      expect(errors).toEqual([]);
    } finally { await Promise.all([partyContext.close(), respondentContext.close(), managerContext.close(), outsiderContext.close()]); }
  });
}
