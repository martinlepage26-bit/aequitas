import "../src/lib/loadEnv";
import { test, expect } from "@playwright/test";
import { seedKnowledgeCase } from "../test/fixtures/seedKnowledgeCase";
import { SESSION_COOKIE } from "../src/lib/session";
import { signPayload } from "../src/lib/signedCookie";
import en from "../messages/en-CA.json";
import fr from "../messages/fr-CA.json";

for (const [locale, messages] of [["en-CA", en], ["fr-CA", fr]] as const) {
  test(`core map review and draft privacy in ${locale}`, async ({ browser }) => {
    const seeded = await seedKnowledgeCase();
    const manager = await browser.newContext({ baseURL: "http://localhost:3000" });
    const party = await browser.newContext({ baseURL: "http://localhost:3000" });
    try {
      await manager.addCookies([{ name: SESSION_COOKIE, value: signPayload({ userId: seeded.manager.id, globalRole: "CASE_MANAGER" }, 3600), url: "http://localhost:3000" }]);
      await party.addCookies([{ name: SESSION_COOKIE, value: signPayload({ userId: seeded.complainant.id, globalRole: "COMPLAINANT" }, 3600), url: "http://localhost:3000" }]);
      const page = await manager.newPage();
      const url = `/${locale}/cases/${seeded.caseRow.id}`;
      await page.goto(url);
      await expect(page.getByRole("heading", { name: messages.knowledgeMap.title })).toBeVisible();
      await expect(page.locator("article blockquote p").filter({ hasText: /^Je me suis senti humilié\.$/ })).toBeVisible();
      const partyPage = await party.newPage();
      await partyPage.goto(url);
      await expect(partyPage.getByRole("heading", { name: messages.knowledgeMap.title })).toHaveCount(0);
      await page.getByText(messages.knowledgeReview.title, { exact: true }).click();
      await page.locator("#review-reasoning").fill("The source record preserves unresolved disagreement.");
      await page.locator("#review-reason").fill("Preserve uncertainty for human review.");
      const saved = page.waitForResponse(response => response.url().endsWith(`/api/cases/${seeded.caseRow.id}/draft`) && response.request().method() === "PATCH");
      await page.getByRole("button", { name: messages.knowledgeReview.save, exact: true }).click();
      expect((await saved).status()).toBe(200);
      await expect(page.getByText("The source record preserves unresolved disagreement.", { exact: false }).first()).toBeVisible();
      await page.getByText(messages.knowledgeGraph.title, { exact: true }).click();
      await page.locator("#knowledge-node").selectOption(seeded.explanation.knowledge_sources![0].id);
      await expect(page.getByRole("heading", { name: messages.knowledgeGraph.original })).toBeVisible();
      expect((await party.request.get(`/api/cases/${seeded.caseRow.id}/knowledge-map`)).status()).toBe(404);
    } finally {
      await manager.close(); await party.close();
    }
  });
}
