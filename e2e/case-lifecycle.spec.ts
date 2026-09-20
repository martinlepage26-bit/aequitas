import "../src/lib/loadEnv";
import { randomUUID } from "node:crypto";
import { test, expect, type BrowserContext } from "@playwright/test";
import { prisma } from "../src/lib/prisma";
import { signPayload } from "../src/lib/signedCookie";
import { SESSION_COOKIE } from "../src/lib/session";
import frMessages from "../messages/fr-CA.json";
import enMessages from "../messages/en-CA.json";

/**
 * M2's own "Done when" criterion (Section 19): "M2 E2E segment passes in
 * both locales." Drives the real browser through the actual UI — intake
 * wizard -> submit -> case-manager opens intake -> both parties submit
 * evidence -> case-manager closes intake -> both parties submit positions —
 * for each of fr-CA and en-CA, asserting on each locale's own translated
 * copy (pulled from the message catalogs directly, not hardcoded, so this
 * test can't silently drift from what check:i18n-parity already guarantees
 * stays in sync between the two).
 */

const LOCALES = [
  { code: "fr-CA", messages: frMessages },
  { code: "en-CA", messages: enMessages },
] as const;

function cookieFor(userId: string, globalRole: string): string {
  const token = signPayload({ userId, globalRole }, 60 * 60);
  return `${SESSION_COOKIE}=${token}`;
}

async function contextFor(browser: import("@playwright/test").Browser, userId: string, globalRole: string): Promise<BrowserContext> {
  const context = await browser.newContext();
  await context.addCookies([
    { name: SESSION_COOKIE, value: cookieFor(userId, globalRole).split("=").slice(1).join("="), url: "http://localhost:3000" },
  ]);
  return context;
}

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

for (const { code: locale, messages: m } of LOCALES) {
  test.describe(`M2 E2E — intake -> evidence -> positions (${locale})`, () => {
    test(`consumer and retailer carry a case from intake through positions in ${locale}`, async ({ browser }) => {
      const consumer = await prisma.user.create({
        data: { email: `e2e-consumer-${randomUUID()}@example.com`, displayName: `E2E Consumer ${locale}`, globalRole: "COMPLAINANT", locale },
      });
      const retailer = await prisma.user.create({
        data: { email: `e2e-retailer-${randomUUID()}@example.com`, displayName: `E2E Retailer ${locale}`, globalRole: "RESPONDENT", locale },
      });
      const manager = await prisma.user.create({
        data: { email: `e2e-manager-${randomUUID()}@example.com`, displayName: `E2E Manager ${locale}`, globalRole: "CASE_MANAGER", locale },
      });
      await prisma.consentStatementVersion.create({
        data: { version: Number.parseInt(randomUUID().replaceAll("-", "").slice(0, 8), 16) % 2_000_000_000, locale, body: `E2E test consent statement (${locale}).`, effectiveFrom: new Date() },
      });

      const consumerCtx = await contextFor(browser, consumer.id, "COMPLAINANT");
      const retailerCtx = await contextFor(browser, retailer.id, "RESPONDENT");
      const managerCtx = await contextFor(browser, manager.id, "CASE_MANAGER");

      try {
        // --- Intake wizard: consumer creates and submits the case ---
        const consumerPage = await consumerCtx.newPage();
        await consumerPage.goto(`/${locale}/cases/new`);
        await consumerPage.fill("#respondent-email", retailer.email);
        await consumerPage.check("#acknowledge");
        await consumerPage.click(`button:has-text("${m.newCase.submitButton}")`);
        await consumerPage.waitForURL(new RegExp(`/${locale}/cases/[0-9a-f-]+$`));
        const caseId = consumerPage.url().split("/").pop()!;

        await expect(consumerPage.locator("h1 + p strong")).toHaveText(m.workspace.state.DRAFT);
        await consumerPage.click(`button:has-text("${m.workspace.draft.submitButton}")`);
        await expect(consumerPage.locator("h1 + p strong")).toHaveText(m.workspace.state.OPEN);

        // --- Case manager opens evidence intake ---
        const managerPage = await managerCtx.newPage();
        await managerPage.goto(`/${locale}/cases/${caseId}`);
        await managerPage.click(`button:has-text("${m.workspace.open.openButton}")`);
        await expect(managerPage.locator("h1 + p strong")).toHaveText(m.workspace.state.EVIDENCE_INTAKE);

        // --- Both parties submit evidence through the real form ---
        await consumerPage.goto(`/${locale}/cases/${caseId}`);
        await consumerPage.selectOption("#evidence-kind", "DOCUMENT");
        await consumerPage.fill("#evidence-title", `Consumer evidence (${locale})`);
        await consumerPage.setInputFiles("#evidence-file", { name: "proof.png", mimeType: "image/png", buffer: TINY_PNG });
        await consumerPage.click(`button:has-text("${m.workspace.evidence.form.submit}")`);
        await expect(consumerPage.locator("#evidence-heading ~ ul li")).toHaveCount(1);

        const retailerPage = await retailerCtx.newPage();
        await retailerPage.goto(`/${locale}/cases/${caseId}`);
        await retailerPage.selectOption("#evidence-kind", "DOCUMENT");
        await retailerPage.fill("#evidence-title", `Retailer evidence (${locale})`);
        await retailerPage.setInputFiles("#evidence-file", { name: "proof.png", mimeType: "image/png", buffer: TINY_PNG });
        await retailerPage.click(`button:has-text("${m.workspace.evidence.form.submit}")`);
        await expect(retailerPage.locator("#evidence-heading ~ ul li")).toHaveCount(2);

        // --- Case manager closes evidence intake now both parties have submitted ---
        await managerPage.reload();
        await managerPage.click(`button:has-text("${m.workspace.intake.closeButton}")`);
        await expect(managerPage.locator("h1 + p strong")).toHaveText(m.workspace.state.POSITIONS);

        // --- Both parties submit their positions ---
        await consumerPage.goto(`/${locale}/cases/${caseId}`);
        await consumerPage.fill("#position-body", `Consumer position (${locale}).`);
        await consumerPage.click(`button:has-text("${m.workspace.positions.form.submit}")`);
        await expect(consumerPage.locator("#positions-heading ~ ul li")).toHaveCount(1);

        await retailerPage.goto(`/${locale}/cases/${caseId}`);
        await retailerPage.fill("#position-body", `Retailer position (${locale}).`);
        await retailerPage.click(`button:has-text("${m.workspace.positions.form.submit}")`);
        await expect(retailerPage.locator("#positions-heading ~ ul li")).toHaveCount(2);

        // --- Case manager now sees the requestDraft authority, having no more evidence/position forms to act on ---
        await managerPage.reload();
        await expect(managerPage.locator("h1 + p strong")).toHaveText(m.workspace.state.POSITIONS);
        // CASE_CREATED, CASE_SUBMITTED, EVIDENCE_INTAKE_OPENED, CASE_ASSIGNED,
        // EVIDENCE_SUBMITTED x2, EVIDENCE_INTAKE_CLOSED, POSITION_SUBMITTED x2.
        await expect(managerPage.locator("#timeline-heading ~ ol li")).toHaveCount(9);
      } finally {
        await consumerCtx.close();
        await retailerCtx.close();
        await managerCtx.close();
      }
    });
  });
}
