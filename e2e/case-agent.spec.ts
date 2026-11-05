import "../src/lib/loadEnv";
import { createHash, randomUUID } from "node:crypto";
import { test, expect, type Browser, type BrowserContext } from "@playwright/test";
import { prisma } from "../src/lib/prisma";
import { signPayload } from "../src/lib/signedCookie";
import { SESSION_COOKIE } from "../src/lib/session";
import { closeIntake, createCase, openIntake, submitCase, submitPosition } from "../src/domain/mutate";
import { enrollCaseAgent, runCaseAgent } from "../src/domain/caseAgent/agent";
import fr from "../messages/fr-CA.json";
import en from "../messages/en-CA.json";

// Synthetic data; the model is a local stub run in this test process. The
// web server never calls a model.

const port = process.env.PLAYWRIGHT_PORT ?? 3000;
const ENV = { AEQUITAS_CASE_AGENT_ENABLED: "true", AEQUITAS_CASE_AGENT_MAX_AMOUNT_CENTS: "500000" };

async function contextFor(browser: Browser, userId: string, globalRole: string): Promise<BrowserContext> {
  const context = await browser.newContext();
  await context.addCookies([{ name: SESSION_COOKIE, value: signPayload({ purpose: "session", userId, globalRole, authMethod: "dev-bypass" }, 3600), url: `http://localhost:${port}` }]);
  return context;
}

for (const [locale, messages] of [["fr-CA", fr], ["en-CA", en]] as const) {
  test(`parties see the assistant notice and can ask for a person (${locale})`, async ({ browser }) => {
    test.setTimeout(120_000);
    const copy = messages.workspace.caseAgent;
    if (!(await prisma.user.findFirst({ where: { globalRole: "CASE_AGENT" } }))) {
      await prisma.user.create({ data: { email: `case-agent-${randomUUID()}@aequitas.invalid`, displayName: "Automated assistant", globalRole: "CASE_AGENT" } });
    }
    const mk = (label: string, globalRole: "COMPLAINANT" | "RESPONDENT" | "CASE_MANAGER") =>
      prisma.user.create({ data: { email: `agent-e2e-${label}-${randomUUID()}@example.org`, displayName: `Agent ${label} ${locale}`, globalRole, locale } });
    const [c, r, m] = await Promise.all([mk("c", "COMPLAINANT"), mk("r", "RESPONDENT"), mk("m", "CASE_MANAGER")]);
    const statement = await prisma.consentStatementVersion.create({ data: { version: Number.parseInt(randomUUID().replaceAll("-", "").slice(0, 8), 16) % 2_000_000_000, locale, body: "Synthetic.", effectiveFrom: new Date() } });
    const created = await createCase({ actorId: c.id, actorRole: "COMPLAINANT", referenceNumber: `AE-AGENTE2E-${randomUUID().slice(0, 8)}`, complainantId: c.id, respondentId: r.id, simulated: true, category: "RETAIL", amountAtStakeCents: 5000, disputeDescription: "Synthetic kettle dispute.", requestedStatementVersionId: statement.id, currentStatementVersionId: statement.id });
    if (!created.ok) throw new Error(created.reason);
    const caseId = created.data.caseId;
    await submitCase({ actorId: c.id, actorRole: "COMPLAINANT", caseId });
    await openIntake({ actorId: m.id, actorRole: "CASE_MANAGER", caseId, hasConflict: false });
    const ids: string[] = [];
    for (const party of [c, r]) {
      const body = Buffer.from(randomUUID());
      ids.push((await prisma.evidenceItem.create({ data: { caseId, submittedById: party.id, kind: "RECEIPT", title: `File ${party.globalRole}`, storageKey: `simulated/e2e/${randomUUID()}`, sha256: createHash("sha256").update(body).digest("hex"), byteSize: body.byteLength, mimeType: "text/plain", scanStatus: "CLEAN", simulated: true } })).id);
    }
    await closeIntake({ actorId: m.id, actorRole: "CASE_MANAGER", caseId });
    await submitPosition({ actorId: c.id, actorRole: "COMPLAINANT", caseId, body: "Position A synthetic.", locale });
    await submitPosition({ actorId: r.id, actorRole: "RESPONDENT", caseId, body: "Position B synthetic.", locale });
    const enrolled = await enrollCaseAgent({ actorId: m.id, actorRole: "CASE_MANAGER", caseId }, ENV);
    if (!enrolled.ok) throw new Error(enrolled.reason);
    const outcomeC = `OUTCOME-C-${randomUUID()}`;
    const outcomeR = `OUTCOME-R-${randomUUID()}`;
    const run = await runCaseAgent({ caseId, env: ENV, model: { provider: "test", model: "stub", complete: async () => JSON.stringify({
      needs_human: null, summary: "Summary.", reasoning: "Reasoning.", limits: ["Limit."], not_considered: ["Other losses."],
      citations: [{ evidence_item_id: ids[0], relevance: "Receipt." }],
      outcomes: { complainant: { text: outcomeC, evidence_item_ids: [ids[0]] }, respondent: { text: outcomeR, evidence_item_ids: [ids[1]] } },
    }) } });
    expect(run.status).toBe("issued");

    const [cc, rc, mc] = await Promise.all([contextFor(browser, c.id, "COMPLAINANT"), contextFor(browser, r.id, "RESPONDENT"), contextFor(browser, m.id, "CASE_MANAGER")]);
    const [cp, rp, mp] = await Promise.all([cc.newPage(), rc.newPage(), mc.newPage()]);
    await cp.goto(`/${locale}/cases/${caseId}`);
    await expect(cp.locator("#case-agent-notice")).toHaveText(copy.partyNotice);
    await expect(cp.locator("#your-outcome")).toHaveText(outcomeC);
    expect(await cp.content()).not.toContain(outcomeR);
    await mp.goto(`/${locale}/cases/${caseId}`);
    await expect(mp.locator("#case-agent-status")).toHaveText(copy.managerActive);

    await cp.waitForLoadState("networkidle");
    const requested = cp.waitForResponse((res) => new URL(res.url()).pathname === `/api/cases/${caseId}/human-review`);
    await cp.locator("#request-human-review").click();
    expect((await requested).ok()).toBe(true);
    await expect(cp.locator("#case-agent-escalated")).toHaveText(copy.partyEscalated);
    await expect(cp.getByText(messages.workspace.timeline.event.AGENT_ESCALATED)).toBeVisible();

    await rp.goto(`/${locale}/cases/${caseId}`);
    await expect(rp.locator("#case-agent-escalated")).toHaveText(copy.partyEscalated);
    await expect(rp.getByText(messages.workspace.timeline.event.AGENT_ESCALATED)).toHaveCount(0);
    expect(await rp.content()).not.toContain(outcomeC);

    await mp.reload();
    await expect(mp.locator("#case-agent-status")).toHaveText(copy.managerEscalated.replace("{reason}", copy.reason.party_request));
    // A non-party cannot ask on a party's behalf.
    expect((await mc.request.post(`/api/cases/${caseId}/human-review`)).status()).toBe(404);
    await Promise.all([cc.close(), rc.close(), mc.close()]);
  });
}
