import "../src/lib/loadEnv";
import { randomUUID } from "node:crypto";
import { test, expect, type Browser, type BrowserContext } from "@playwright/test";
import { prisma } from "../src/lib/prisma";
import { uploadEvidence } from "../src/lib/storage";
import { signPayload } from "../src/lib/signedCookie";
import { SESSION_COOKIE } from "../src/lib/session";
import { closeIntake, createCase, openIntake, submitCase, submitPosition } from "../src/domain/mutate";
import { enrollCaseAgent, runCaseAgent } from "../src/domain/caseAgent/agent";
import fr from "../messages/fr-CA.json";
import en from "../messages/en-CA.json";

// Synthetic data; the model is a local stub run in this test process. The
// web server never calls a model.

const port = process.env.PLAYWRIGHT_PORT ?? 3000;
// Synthetic program rules for tests only.
const ENV = { AEQUITAS_CASE_AGENT_ENABLED: "true", AEQUITAS_CASE_AGENT_MAX_AMOUNT_CENTS: "500000", AEQUITAS_CASE_AGENT_INTAKE_DAYS: "7", AEQUITAS_CASE_AGENT_RESPONSE_DAYS: "5", AEQUITAS_CASE_AGENT_RESPONDENT_MAY_WITHDRAW: "true" };

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
    const evidence = [
      { party: c, text: "Receipt: kettle purchase $89.99 on 2026-10-02. Return period: 30 days.", excerpt: "kettle purchase $89.99 on 2026-10-02" },
      { party: r, text: "Store note: final-sale item; repair voucher offered on 2026-10-05.", excerpt: "repair voucher offered on 2026-10-05" },
    ];
    const ids: string[] = [];
    for (const { party, text } of evidence) {
      const id = randomUUID();
      const stored = await uploadEvidence({ caseId, evidenceId: id, simulated: true, buffer: Buffer.from(text), mimeType: "text/plain" });
      await prisma.evidenceItem.create({ data: { id, caseId, submittedById: party.id, kind: "RECEIPT", title: `File ${party.globalRole}`, ...stored, mimeType: "text/plain", scanStatus: "CLEAN", simulated: true } });
      ids.push(id);
    }
    await closeIntake({ actorId: m.id, actorRole: "CASE_MANAGER", caseId });
    await submitPosition({ actorId: c.id, actorRole: "COMPLAINANT", caseId, body: "Position A synthetic.", locale });
    await submitPosition({ actorId: r.id, actorRole: "RESPONDENT", caseId, body: "Position B synthetic.", locale });
    const enrolled = await enrollCaseAgent({ actorId: m.id, actorRole: "CASE_MANAGER", caseId }, ENV);
    if (!enrolled.ok) throw new Error(enrolled.reason);
    const run = await runCaseAgent({ caseId, env: ENV, model: { provider: "test", model: "stub", complete: async () => JSON.stringify({
      needs_human: null, summary: "Summary.", reasoning: "Reasoning.", limits: ["Limit."], not_considered: ["Other losses."],
      citations: [
        { evidence_item_id: ids[0], relevance: "Receipt documents the purchase.", excerpt: evidence[0].excerpt },
        { evidence_item_id: ids[1], relevance: "Store note records the offered remedy.", excerpt: evidence[1].excerpt },
      ],
      proposal: { remedy: "repair", amount_cents: null },
      party_evidence: { complainant: [ids[0]], respondent: [ids[1]] },
    }) } });
    expect(run.status).toBe("issued");
    const issuedC = await prisma.partyOutcome.findFirstOrThrow({
      where: { caseId, partyId: c.id, status: "ISSUED" },
      include: { citations: true },
    });
    const issuedR = await prisma.partyOutcome.findFirstOrThrow({
      where: { caseId, partyId: r.id, status: "ISSUED" },
      include: { citations: true },
    });
    const citationC = issuedC.citations[0];
    const citationR = issuedR.citations[0];
    if (!citationC || !citationR) throw new Error("Missing party citation");
    const outcomeC = issuedC.body;
    const outcomeR = issuedR.body;
    expect(outcomeC).not.toBe(outcomeR);

    const [cc, rc, mc] = await Promise.all([contextFor(browser, c.id, "COMPLAINANT"), contextFor(browser, r.id, "RESPONDENT"), contextFor(browser, m.id, "CASE_MANAGER")]);
    const [cp, rp, mp] = await Promise.all([cc.newPage(), rc.newPage(), mc.newPage()]);
    await cp.goto(`/${locale}/cases/${caseId}`);
    await expect(cp.locator("#case-agent-notice")).toHaveText(copy.partyNotice);
    await expect(cp.locator("#your-outcome")).toHaveText(outcomeC);
    const complainantCitations = cp.getByRole("region", { name: messages.workspace.partyOutcome.citationHeading });
    await expect(complainantCitations).toBeVisible();
    await expect(complainantCitations.getByRole("link", { name: "File COMPLAINANT" })).toBeVisible();
    await complainantCitations.getByRole("button", { name: messages.workspace.partyOutcome.viewExcerpt }).click();
    await expect(complainantCitations.locator("blockquote")).toHaveText(evidence[0].excerpt);
    expect(await cp.content()).not.toContain(outcomeR);
    await mp.goto(`/${locale}/cases/${caseId}`);
    await expect(mp.locator("#case-agent-status")).toHaveText(copy.managerActive);

    await rp.goto(`/${locale}/cases/${caseId}`);
    await expect(rp.locator("#your-outcome")).toHaveText(outcomeR);
    expect(await rp.content()).not.toContain(outcomeC);
    expect(await rp.content()).not.toContain("File COMPLAINANT");
    const respondentCitations = rp.getByRole("region", { name: messages.workspace.partyOutcome.citationHeading });
    await expect(respondentCitations.getByRole("link", { name: "File RESPONDENT" })).toBeVisible();
    await respondentCitations.getByRole("button", { name: messages.workspace.partyOutcome.viewExcerpt }).click();
    await expect(respondentCitations.locator("blockquote")).toHaveText(evidence[1].excerpt);
    const crossPartyStatus = await rp.evaluate(async (url) => (await fetch(url)).status,
      `/api/cases/${caseId}/party-outcomes/${issuedC.id}/citations/${citationC.id}`);
    expect(crossPartyStatus).toBe(404);

    await cp.waitForLoadState("networkidle");
    const requested = cp.waitForResponse((res) => new URL(res.url()).pathname === `/api/cases/${caseId}/human-review`);
    await cp.locator("#request-human-review").click();
    expect((await requested).ok()).toBe(true);
    await expect(cp.locator("#case-agent-escalated")).toHaveText(copy.partyEscalated);
    await expect(cp.getByText(messages.workspace.timeline.event.AGENT_ESCALATED)).toBeVisible();

    await rp.reload();
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
