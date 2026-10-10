import "../src/lib/loadEnv";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { test, expect, type Browser, type BrowserContext } from "@playwright/test";
import { prisma } from "../src/lib/prisma";
import { signPayload } from "../src/lib/signedCookie";
import { SESSION_COOKIE } from "../src/lib/session";
import { createCase, openIntake, submitCase } from "../src/domain/mutate";
import { recordSource } from "../src/domain/claimWrites";
import { acknowledgeAssumption, recordAssumption, runClaimDecomposition } from "../src/domain/pipeline/writes";
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
    url: `http://localhost:${process.env.PLAYWRIGHT_PORT ?? 3010}`,
  }]);
  return context;
}

for (const [locale, messages] of [["fr-CA", fr], ["en-CA", en]] as const) {
  test(`assumption ledger and a proposal awaiting acceptance in ${locale}`, async ({ browser }) => {
    test.setTimeout(120_000);
    mkdirSync(ARTIFACTS, { recursive: true });
    const suffix = locale === "fr-CA" ? "fr" : "en";
    const copy = messages.workspace.pipeline;
    const assumptionText = locale === "fr-CA"
      ? "Les deux dates peuvent ne pas viser la même remise."
      : "The two dates may not refer to the same handoff.";
    const sourceBody = locale === "fr-CA"
      ? "Laissé à la porte le 2 mars."
      : "Left at the door on 2 March.";
    const claimText = locale === "fr-CA"
      ? "Le colis a été laissé à la porte le 2 mars."
      : "The parcel was left at the door on 2 March.";

    const complainant = await prisma.user.create({
      data: { email: `p2-c-${randomUUID()}@example.com`, displayName: `P2 Complainant ${suffix}`, globalRole: "COMPLAINANT", locale },
    });
    const respondent = await prisma.user.create({
      data: { email: `p2-r-${randomUUID()}@example.com`, displayName: `P2 Respondent ${suffix}`, globalRole: "RESPONDENT", locale },
    });
    const manager = await prisma.user.create({
      data: { email: `p2-m-${randomUUID()}@example.com`, displayName: `P2 Manager ${suffix}`, globalRole: "CASE_MANAGER", locale },
    });
    const statement = await prisma.consentStatementVersion.create({
      data: {
        version: Number.parseInt(randomUUID().replaceAll("-", "").slice(0, 8), 16) % 2_000_000_000,
        locale,
        body: `Pipeline e2e consent (${locale}).`,
        effectiveFrom: new Date(),
      },
    });
    const created = await createCase({
      actorId: complainant.id,
      actorRole: "COMPLAINANT",
      referenceNumber: `AE-P2-${randomUUID()}`,
      complainantId: complainant.id,
      respondentId: respondent.id,
      disputeDescription: assumptionText,
      simulated: true,
      requestedStatementVersionId: statement.id,
      currentStatementVersionId: statement.id,
    });
    if (!created.ok) throw new Error(created.reason);
    const caseId = created.data.caseId;
    if (!(await submitCase({ actorId: complainant.id, actorRole: "COMPLAINANT", caseId })).ok) throw new Error("submit failed");
    if (!(await openIntake({ actorId: manager.id, actorRole: "CASE_MANAGER", caseId, hasConflict: false })).ok) throw new Error("intake failed");

    const actor = { caseId, actorId: manager.id, actorRole: "CASE_MANAGER" as const };
    const source = await recordSource({ ...actor, kind: "DOCUMENT", title: `Delivery note ${suffix}`, body: sourceBody, language: locale });
    if (!source.ok) throw new Error(source.reason);
    const assumption = await recordAssumption({ ...actor, text: assumptionText, origin: "CASE_FRAMING" });
    if (!assumption.ok) throw new Error(assumption.reason);
    if (!(await acknowledgeAssumption({ ...actor, assumptionId: assumption.data.id })).ok) throw new Error("ack failed");
    const proposed = await runClaimDecomposition(actor, {
      provider: "mock",
      model: "mock-free",
      async complete() {
        return JSON.stringify({
          claims: [{ claim_type: "fact", text: claimText, excerpt: sourceBody, source_id: source.data.id }],
        });
      },
    });
    if (!proposed.ok) throw new Error(proposed.reason);

    const context = await contextFor(browser, manager.id, "CASE_MANAGER");
    const page = await context.newPage();
    await page.goto(`/${locale}/cases/${caseId}`);
    const panel = page.locator("[data-pipeline-panel]");
    await expect(panel.getByRole("heading", { name: copy.title })).toBeVisible();
    await expect(panel.getByText(assumptionText)).toBeVisible();
    await expect(panel.getByText(copy.assumptionStatus.ACKNOWLEDGED)).toBeVisible();
    await panel.screenshot({ path: `${ARTIFACTS}/phase2-ledger-${suffix}.png` });
    const proposal = panel.locator("[data-proposal-status=awaiting]");
    await expect(proposal.getByText(claimText)).toBeVisible();
    await expect(proposal.getByText(copy.awaiting)).toBeVisible();
    await proposal.screenshot({ path: `${ARTIFACTS}/phase2-proposal-${suffix}.png` });
    await context.close();
  });
}
