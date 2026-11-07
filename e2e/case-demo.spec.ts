import { test, expect } from "@playwright/test";
import fr from "../messages/fr-CA.json";
import en from "../messages/en-CA.json";

for (const [locale, messages] of [["fr-CA", fr], ["en-CA", en]] as const) {
  test(`public synthetic case walkthrough is clear in ${locale}`, async ({ page }) => {
    await page.goto(`/${locale}/demo`);

    await expect(page.getByRole("heading", { level: 1, name: messages.caseDemo.title })).toBeVisible();
    await expect(page.getByRole("note")).toContainText(messages.caseDemo.sampleNoticeBody);
    await expect(page.getByRole("heading", { name: messages.caseDemo.evidenceTitle })).toBeVisible();
    await expect(page.getByRole("heading", { name: messages.caseDemo.proposalTitle })).toBeVisible();
    await expect(page.getByRole("heading", { name: messages.caseDemo.workflowTitle })).toBeVisible();
    await expect(page.getByRole("link", { name: messages.caseDemo.signIn })).toHaveAttribute("href", `/${locale}/auth/sign-in`);
  });
}
