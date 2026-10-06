import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import en from "../messages/en-CA.json";
import fr from "../messages/fr-CA.json";
import { prisma } from "../src/lib/prisma";
import { signPayload } from "../src/lib/signedCookie";

// The URL does not change until the WebAuthn route responds and the client
// navigation commits. CI's first e2e test compiles that route inside the wait
// (`next dev` has no warm cache). Playwright's default 5s expect timeout then
// expires while the page is still on sign-in?next=/cases/new; the same test
// passes for the other locale once the route is compiled. A longer wait still
// requires the protected URL, so a redirect back to sign-in fails.
const coldAuthNavigation = { timeout: 20_000 };

for (const [locale, messages] of [["en-CA", en], ["fr-CA", fr]] as const) {
  test(`passkey registration, sign-out and discoverable sign-in (${locale})`, async ({ page }) => {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    const email = `browser-auth-${randomUUID()}@example.com`;
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto(`/${locale}/cases/new`);
    await expect(page).toHaveURL(new RegExp(`/${locale}/auth/sign-in\\?next=`));
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    await page.getByRole("button", { name: messages.auth.register, exact: true }).click();
    await page.locator("#email").fill(email);
    await page.locator("#displayName").fill("Browser passkey test");
    await page.getByRole("button", { name: messages.auth.create, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/${locale}/cases/new$`), coldAuthNavigation);
    await page.getByRole("button", { name: messages.auth.signOut, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/${locale}/auth/sign-in$`), coldAuthNavigation);
    expect((await page.context().cookies()).some(cookie => cookie.name === "aequitas_session")).toBe(false);
    await page.locator("#email").fill(email);
    await page.getByRole("button", { name: messages.auth.continue, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/${locale}/cases$`), coldAuthNavigation);
    expect(errors).toEqual([]);
  });

  test(`cancel a stalled passkey request (${locale})`, async ({ page }) => {
    let release: () => void = () => {};
    await page.route("**/api/auth/webauthn/authenticate", async route => {
      await new Promise<void>(resolve => { release = resolve; });
      await route.abort();
    });
    await page.goto(`/${locale}/auth/sign-in`);
    await page.locator("#email").fill("device-test@example.com");
    await page.getByRole("button", { name: messages.auth.continue, exact: true }).click();
    await expect(page.getByRole("button", { name: messages.auth.cancel, exact: true })).toBeVisible();
    await page.getByRole("button", { name: messages.auth.cancel, exact: true }).click();
    release();
    await expect(page.getByRole("button", { name: messages.auth.continue, exact: true })).toBeEnabled();
    await expect(page.getByRole("alert").filter({ hasText: messages.auth.cancelled })).toHaveText(messages.auth.cancelled);
  });

  test(`administrator issues and revokes an invitation (${locale})`, async ({ page, browser, baseURL }) => {
    const admin = await prisma.user.create({ data: { email: `browser-admin-${randomUUID()}@example.com`, displayName: "Browser administrator", globalRole: "ADMIN", locale } });
    await page.context().addCookies([{ name: "aequitas_session", value: signPayload({ purpose: "session", userId: admin.id, globalRole: "ADMIN", authMethod: "dev-bypass" }, 3600), url: baseURL! }]);
    const email = `browser-invite-${randomUUID()}@example.com`;
    await page.goto(`/${locale}/admin/invites`);
    await page.getByLabel(messages.adminInvites.email, { exact: true }).fill(email);
    await page.getByLabel(messages.adminInvites.displayName, { exact: true }).fill("Invited manager");
    await page.getByRole("combobox", { name: messages.adminInvites.role, exact: true }).selectOption("CASE_MANAGER");
    await page.getByRole("button", { name: messages.adminInvites.issue, exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: messages.adminInvites.delivery.manual })).toBeVisible();
    const claimUrl = await page.getByLabel(messages.adminInvites.claimLink, { exact: true }).inputValue();
    const publicContext = await browser.newContext();
    try {
      const invitePage = await publicContext.newPage();
      await invitePage.goto(claimUrl);
      await expect(invitePage.getByRole("button", { name: messages.invite.submit, exact: true })).toBeVisible();
      await page.getByRole("row").filter({ hasText: email }).getByRole("button", { name: messages.adminInvites.revoke, exact: true }).click();
      await expect(page.getByRole("status").filter({ hasText: messages.adminInvites.revoked })).toBeVisible();
      await invitePage.reload();
      await expect(invitePage.getByRole("alert").filter({ hasText: messages.invite.invalid })).toHaveText(messages.invite.invalid);
      await expect(invitePage.getByRole("link", { name: messages.invite.home, exact: true })).toBeVisible();
    } finally { await publicContext.close(); }
  });
}
