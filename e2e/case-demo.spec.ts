import { test, expect } from "@playwright/test";
import fr from "../messages/fr-CA.json";
import en from "../messages/en-CA.json";

for (const [locale, messages] of [["fr-CA", fr], ["en-CA", en]] as const) {
  test(`public synthetic case simulation is clear and stays local in ${locale}`, async ({ page }) => {
    const apiRequests: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.startsWith("/api/")) apiRequests.push(request.url());
    });
    await page.goto(`/${locale}/demo`);

    await expect(page.getByRole("heading", { level: 1, name: messages.caseDemo.title })).toBeVisible();
    await expect(page.getByRole("note")).toContainText(messages.caseDemo.sampleNoticeBody);
    await expect(page.getByTestId("case-demo-interaction")).toBeVisible();
    await expect(page.getByRole("heading", { name: messages.caseDemo.evidenceTitle })).toBeVisible();
    await expect(page.getByRole("heading", { name: messages.caseDemo.proposalTitle })).toBeVisible();
    await expect(page.getByRole("heading", { name: messages.caseDemo.workflowTitle })).toBeVisible();
    await expect(page.getByRole("link", { name: messages.caseDemo.signIn })).toHaveAttribute("href", `/${locale}/auth/sign-in`);

    const interaction = messages.caseDemo.interaction;
    const status = page.getByRole("status");
    await expect(status).toHaveText(interaction.status.initial);

    await page.getByRole("button", { name: interaction.consent }).click();
    await expect(status).toHaveText(interaction.status.accepted);
    await page.getByRole("button", { name: messages.caseDemo.party.respondent }).click();
    await page.getByRole("button", { name: interaction.askPerson }).click();
    await expect(status).toHaveText(interaction.status.handoff);

    await page.getByRole("button", { name: interaction.reset }).click();
    await page.getByRole("button", { name: interaction.consent }).click();
    await page.getByRole("button", { name: messages.caseDemo.party.respondent }).click();
    await page.getByRole("button", { name: interaction.consent }).click();
    await expect(status).toHaveText(interaction.status.completed);

    await page.getByRole("button", { name: interaction.reset }).click();
    await page.getByRole("button", { name: interaction.decline }).click();
    await expect(status).toHaveText(interaction.status.handoff);
    expect(apiRequests).toEqual([]);
  });
}
