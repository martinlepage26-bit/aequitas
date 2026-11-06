import "../src/lib/loadEnv";
import { randomUUID } from "node:crypto";
import { test, expect, type Browser, type BrowserContext } from "@playwright/test";
import { prisma } from "../src/lib/prisma";
import { signPayload } from "../src/lib/signedCookie";
import { SESSION_COOKIE } from "../src/lib/session";
import { createCase, submitCase } from "../src/domain/mutate";
import { invitationTokenHash } from "../src/lib/invitations";
import fr from "../messages/fr-CA.json";
import en from "../messages/en-CA.json";

const port = process.env.PLAYWRIGHT_PORT ?? 3000;
const DAY = 24 * 60 * 60 * 1000;

async function contextFor(browser: Browser, userId: string): Promise<BrowserContext> {
  const context = await browser.newContext();
  await context.addCookies([{
    name: SESSION_COOKIE,
    value: signPayload({ purpose: "session", userId, globalRole: "COMPLAINANT", authMethod: "dev-bypass" }, 3600),
    url: `http://localhost:${port}`,
  }]);
  return context;
}

// A fresh send can only be queued (delivery_pending); an existing unemailed
// link is reported as delivery_uncertain. Neither may read as "sent".
for (const [locale, messages] of [["fr-CA", fr], ["en-CA", en]] as const) for (const deliveryStatus of ["delivery_pending", "delivery_uncertain"] as const) {
  test(`shows an unconfirmed respondent invitation (${deliveryStatus}) and prevents duplicate sending (${locale})`, async ({ browser }) => {
    const complainant = await prisma.user.create({
      data: { email: `invite-c-${randomUUID()}@example.org`, displayName: `Invite complainant ${locale}`, globalRole: "COMPLAINANT", locale },
    });
    const respondent = await prisma.user.create({
      data: { email: `invite-r-${randomUUID()}@example.org`, displayName: `Invite respondent ${locale}`, globalRole: "RESPONDENT", locale },
    });
    const statement = await prisma.consentStatementVersion.create({
      data: { version: Number.parseInt(randomUUID().replaceAll("-", "").slice(0, 8), 16) % 2_000_000_000, locale, body: `Synthetic consent ${locale}.`, effectiveFrom: new Date() },
    });
    const created = await createCase({
      actorId: complainant.id, actorRole: "COMPLAINANT", referenceNumber: `AE-INVITE-${randomUUID().slice(0, 8)}`,
      complainantId: complainant.id, respondentId: respondent.id, simulated: true,
      disputeDescription: "Synthetic invitation-delivery uncertainty test.",
      requestedStatementVersionId: statement.id, currentStatementVersionId: statement.id,
    });
    if (!created.ok) throw new Error(created.reason);
    const caseId = created.data.caseId;
    expect((await submitCase({ actorId: complainant.id, actorRole: "COMPLAINANT", caseId })).ok).toBe(true);

    const context = await contextFor(browser, complainant.id);
    const page = await context.newPage();
    let requests = 0;
    await page.route(`**/api/cases/${caseId}/invite-respondent`, async (route) => {
      requests += 1;
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({ status: deliveryStatus, expiresAt: new Date(Date.now() + DAY).toISOString() }),
      });
    });

    const invite = messages.workspace.inviteRespondent;
    await page.goto(`/${locale}/cases/${caseId}`);
    await page.getByRole("button", { name: invite.openConfirm, exact: true }).click();
    const response = page.waitForResponse((item) => item.url().endsWith(`/api/cases/${caseId}/invite-respondent`));
    await page.getByRole("button", { name: invite.send, exact: true }).click();
    expect((await response).status()).toBe(202);
    await expect(page.getByRole("region", { name: invite.title }).getByRole("status")).toHaveText(invite.uncertain);
    await expect(page.getByRole("button", { name: invite.openConfirm, exact: true })).toHaveCount(0);
    expect(requests).toBe(1);

    // A page reload reads the active, unemailed invitation from storage and
    // retains the warning without exposing or rotating its token.
    await prisma.invitation.create({ data: {
      userId: respondent.id,
      tokenHash: invitationTokenHash(randomUUID()),
      issuedById: complainant.id,
      locale,
      expiresAt: new Date(Date.now() + DAY),
    } });
    await page.reload();
    await expect(page.getByRole("region", { name: invite.title }).getByRole("status")).toHaveText(invite.uncertain);
    await expect(page.getByRole("button", { name: invite.openConfirm, exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: invite.send, exact: true })).toHaveCount(0);
    await context.close();
  });
}
