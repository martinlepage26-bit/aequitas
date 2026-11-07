import { expect, test } from "@playwright/test";

import { expectNoAutomatedWcagViolations } from "./accessibility";
import en from "../messages/en-CA.json";
import fr from "../messages/fr-CA.json";

for (const [locale, messages] of [["fr-CA", fr], ["en-CA", en]] as const) {
  test(`public and sign-in surfaces have no automated WCAG A/AA violations in ${locale}`, async ({ page }) => {
    await page.goto(`/${locale}`);
    await expect(page.getByRole("main")).toBeVisible();
    await expectNoAutomatedWcagViolations(page, `${locale} landing`);

    await page.goto(`/${locale}/demo`);
    await expect(page.getByRole("heading", { level: 1, name: messages.caseDemo.title })).toBeVisible();
    await expectNoAutomatedWcagViolations(page, `${locale} public walkthrough`);

    await page.goto(`/${locale}/auth/sign-in`);
    await expect(page.getByRole("main")).toBeVisible();
    await expectNoAutomatedWcagViolations(page, `${locale} sign-in`);

    await page.getByRole("button", { name: messages.auth.register }).click();
    await expect(page.getByLabel(messages.auth.displayName)).toBeVisible();
    await expectNoAutomatedWcagViolations(page, `${locale} registration`);
  });
}
