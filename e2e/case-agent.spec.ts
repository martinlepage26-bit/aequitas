import "../src/lib/loadEnv";
import { randomUUID } from "node:crypto";
import { test, expect, type Browser, type BrowserContext } from "@playwright/test";
import { prisma } from "../src/lib/prisma";
import { uploadEvidence } from "../src/lib/storage";
import { signPayload } from "../src/lib/signedCookie";
import { SESSION_COOKIE } from "../src/lib/session";
import { closeIntake, createCase, openIntake, submitCase, submitPosition } from "../src/domain/mutate";
import { acceptCaseAgentProcessing, enrollCaseAgent, runCaseAgent } from "../src/domain/caseAgent/agent";
import { caseAgentProgram } from "../src/domain/caseAgent/config";
import { caseAgentEvaluationApprovalIdentity } from "../src/domain/caseAgent/evaluationApproval";
import { RECOMMENDATION_APPROVAL_REQUIRED_KIND } from "../src/lib/mail";
import fr from "../messages/fr-CA.json";
import en from "../messages/en-CA.json";

// Synthetic data; the model is a local stub run in this test process. The
// web server never calls a model.

const port = process.env.PLAYWRIGHT_PORT ?? 3000;
// Synthetic program rules for tests only.
const PROGRAM_ENV = { AEQUITAS_CASE_AGENT_ENABLED: "true", AEQUITAS_CASE_AGENT_MAX_AMOUNT_CENTS: "500000", AEQUITAS_CASE_AGENT_MAX_MODEL_CALLS_PER_UTC_DAY: "1000", AEQUITAS_CASE_AGENT_INTAKE_DAYS: "7", AEQUITAS_CASE_AGENT_RESPONSE_DAYS: "5", AEQUITAS_CASE_AGENT_RESPONDENT_MAY_WITHDRAW: "true", AEQUITAS_CASE_AGENT_CONSENT_ONLY_RESOLUTION: "true", AEQUITAS_CASE_AGENT_PROCESSING_NOTICE_EN: "Synthetic E2E notice: case content would be sent to the configured model provider.", AEQUITAS_CASE_AGENT_PROCESSING_NOTICE_FR: "Avis E2E synthétique : le contenu du dossier serait transmis au fournisseur de modèle configuré.", AEQUITAS_AI_PROVIDER_TERMS_REVIEWED_FOR: "gemini:synthetic-project:gemini-3.8-flash", AEQUITAS_GEMINI_PAID_TIER_CONFIRMED_FOR: "synthetic-project", GEMINI_PROJECT_ID: "synthetic-project", GEMINI_MODEL: "gemini-3.8-flash", GEMINI_API_KEY: "synthetic-test-only" };
// The synthetic provider identity also needs a recorded live-evaluation review.
const ENV = { ...PROGRAM_ENV, AEQUITAS_CASE_AGENT_EVALUATION_REVIEWED_FOR: caseAgentEvaluationApprovalIdentity(PROGRAM_ENV) ?? "" };

async function contextFor(browser: Browser, userId: string, globalRole: string): Promise<BrowserContext> {
  const context = await browser.newContext();
  await context.addCookies([{ name: SESSION_COOKIE, value: signPayload({ purpose: "session", userId, globalRole, authMethod: "dev-bypass" }, 3600), url: `http://localhost:${port}` }]);
  return context;
}

for (const [locale, messages] of [["fr-CA", fr], ["en-CA", en]] as const) {
  test(`parties control intake completion before the agent opens positions (${locale})`, async ({ browser }) => {
    test.setTimeout(120_000);
    const copy = messages.workspace.caseAgent;
    if (!(await prisma.user.findFirst({ where: { globalRole: "CASE_AGENT" } }))) {
      await prisma.user.create({ data: { email: `case-agent-${randomUUID()}@aequitas.invalid`, displayName: "Automated assistant", globalRole: "CASE_AGENT" } });
    }
    const mk = (label: string, globalRole: "COMPLAINANT" | "RESPONDENT" | "CASE_MANAGER") =>
      prisma.user.create({ data: { email: `agent-intake-e2e-${label}-${randomUUID()}@example.org`, displayName: `Intake ${label} ${locale}`, globalRole, locale } });
    const [c, r, m] = await Promise.all([mk("c", "COMPLAINANT"), mk("r", "RESPONDENT"), mk("m", "CASE_MANAGER")]);
    // This scenario starts after the respondent has joined; invitation
    // delivery is covered by the no-manager routine-path E2E journey.
    await prisma.webAuthnCredential.create({ data: { userId: r.id, credentialId: randomUUID(), publicKey: Buffer.from("synthetic"), counter: 0n, transports: [] } });
    const statement = await prisma.consentStatementVersion.create({ data: { version: Number.parseInt(randomUUID().replaceAll("-", "").slice(0, 8), 16) % 2_000_000_000, locale, body: "Synthetic.", effectiveFrom: new Date() } });
    const created = await createCase({ actorId: c.id, actorRole: "COMPLAINANT", referenceNumber: `AE-AGENT-INTAKE-${randomUUID().slice(0, 8)}`, complainantId: c.id, respondentId: r.id, simulated: true, category: "RETAIL", amountAtStakeCents: 5000, disputeDescription: "Synthetic kettle dispute.", requestedStatementVersionId: statement.id, currentStatementVersionId: statement.id });
    if (!created.ok) throw new Error(created.reason);
    const caseId = created.data.caseId;
    await submitCase({ actorId: c.id, actorRole: "COMPLAINANT", caseId });
    await openIntake({ actorId: m.id, actorRole: "CASE_MANAGER", caseId, hasConflict: false });
    for (const party of [c, r]) {
      const id = randomUUID();
      const body = Buffer.from(`Synthetic evidence for ${party.globalRole}.`);
      const stored = await uploadEvidence({ caseId, evidenceId: id, simulated: true, buffer: body, mimeType: "text/plain" });
      await prisma.evidenceItem.create({ data: { id, caseId, submittedById: party.id, kind: "OTHER", title: `Evidence ${party.globalRole}`, description: "Synthetic test evidence.", ...stored, mimeType: "text/plain", scanStatus: "CLEAN", simulated: true } });
    }
    const enrolled = await enrollCaseAgent({ actorId: m.id, actorRole: "CASE_MANAGER", caseId }, ENV);
    if (!enrolled.ok) throw new Error(enrolled.reason);

    const [cc, rc] = await Promise.all([contextFor(browser, c.id, "COMPLAINANT"), contextFor(browser, r.id, "RESPONDENT")]);
    const [cp, rp] = await Promise.all([cc.newPage(), rc.newPage()]);
    await Promise.all([cp.goto(`/${locale}/cases/${caseId}`), rp.goto(`/${locale}/cases/${caseId}`)]);
    await expect(cp.getByRole("heading", { name: copy.intakeReadyTitle })).toBeVisible();
    await expect(rp.getByRole("heading", { name: copy.intakeReadyTitle })).toBeVisible();

    const firstMark = cp.waitForResponse((res) => new URL(res.url()).pathname === `/api/cases/${caseId}/intake-ready` && res.request().method() === "POST");
    await cp.getByRole("button", { name: copy.intakeReadyMark }).click();
    expect((await firstMark).ok()).toBe(true);
    await expect(cp.getByText(copy.intakeReadyMarked)).toBeVisible();
    await expect(rp.getByText(copy.intakeReadyMarked)).toHaveCount(0);

    await cp.getByRole("button", { name: copy.intakeReadyClear }).click();
    await expect(cp.getByText(copy.intakeReadyMarked)).toHaveCount(0);
    const secondComplainantMark = cp.waitForResponse((res) => new URL(res.url()).pathname === `/api/cases/${caseId}/intake-ready` && res.request().method() === "POST");
    await cp.getByRole("button", { name: copy.intakeReadyMark }).click();
    expect((await secondComplainantMark).ok()).toBe(true);
    const waitingModel = { provider: "test", model: "never-called", calls: 0, async complete() { this.calls++; throw new Error("Unexpected model call"); } };
    expect(await runCaseAgent({ caseId, env: ENV, model: waitingModel })).toEqual({ status: "waiting", reason: "parties_completing_intake" });
    expect(waitingModel.calls).toBe(0);

    const respondentMark = rp.waitForResponse((res) => new URL(res.url()).pathname === `/api/cases/${caseId}/intake-ready` && res.request().method() === "POST");
    await rp.getByRole("button", { name: copy.intakeReadyMark }).click();
    expect((await respondentMark).ok()).toBe(true);
    expect(await runCaseAgent({ caseId, env: ENV, model: waitingModel })).toEqual({ status: "intake_closed" });
    expect(waitingModel.calls).toBe(0);
    const row = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
    expect(row.state).toBe("POSITIONS");
    expect(await prisma.notification.count({ where: { caseId, kind: "case_agent_positions_requested" } })).toBe(2);

    await cp.reload();
    await expect(cp.getByRole("heading", { name: copy.intakeReadyTitle })).toHaveCount(0);
    await expect(cp.getByText(messages.workspace.timeline.event.EVIDENCE_INTAKE_CLOSED)).toBeVisible();
    await Promise.all([cc.close(), rc.close()]);
  });

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
    const configured = caseAgentProgram(ENV);
    if (!configured.ok) throw new Error(`Synthetic program is missing: ${configured.missing.join(", ")}`);
    for (const [party, role] of [[c, "COMPLAINANT"], [r, "RESPONDENT"]] as const) {
      const choice = await acceptCaseAgentProcessing({
        actorId: party.id,
        actorRole: role,
        caseId,
        noticeHash: configured.program.processingDisclosure.noticeHash,
        locale: locale as "en-CA" | "fr-CA",
      }, ENV);
      if (!choice.ok) throw new Error(choice.reason);
    }
    const run = await runCaseAgent({ caseId, env: ENV, model: { provider: "test", model: "stub", complete: async () => JSON.stringify({
      needs_human: null,
      summary_claims: [{ text: "The receipt records the purchase.", citation_ids: ["C1"] }, { text: "The store note records the offered remedy.", citation_ids: ["C2"] }],
      reasoning_claims: [{ text: "The records describe different parts of the exchange.", citation_ids: ["C1", "C2"] }],
      limits: ["Limit."], not_considered: ["Other losses."],
      citations: [
        { citation_id: "C1", evidence_item_id: ids[0], relevance: "Receipt documents the purchase.", excerpt: evidence[0].excerpt },
        { citation_id: "C2", evidence_item_id: ids[1], relevance: "Store note records the offered remedy.", excerpt: evidence[1].excerpt },
      ],
      proposal: {
        remedy: "repair", amount_cents: null,
        rationale_claims: [{ text: "The receipt documents the purchase price for this item.", citation_ids: ["C1"] }],
      },
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
    expect(await cp.content()).not.toContain("The receipt records the purchase.");
    expect(await cp.content()).not.toContain("The receipt documents the purchase price for this item.");
    await mp.goto(`/${locale}/cases/${caseId}`);
    await expect(mp.locator("#case-agent-status")).toHaveText(copy.managerActive);
    await expect(mp.getByText(`${messages.workspace.recommendation.claimEvidenceLabel}:`, { exact: true })).toBeVisible();
    await expect(mp.getByText(messages.workspace.recommendation.proposalBasisLabel + ":", { exact: false })).toBeVisible();
    // Each claim's list item holds the claim text and a nested list of its cited sources.
    const receiptClaim = mp.getByRole("listitem").filter({ hasText: "The receipt records the purchase." });
    await expect(receiptClaim).toHaveCount(1);
    await expect(receiptClaim.getByRole("link", { name: "File COMPLAINANT" })).toBeVisible();
    const proposalBasis = mp.getByRole("listitem").filter({ hasText: "The receipt documents the purchase price for this item." });
    await expect(proposalBasis).toHaveCount(1);
    await expect(proposalBasis.getByText(messages.workspace.recommendation.proposalBasisLabel + ":", { exact: false })).toBeVisible();

    await rp.goto(`/${locale}/cases/${caseId}`);
    await expect(rp.locator("#your-outcome")).toHaveText(outcomeR);
    expect(await rp.content()).not.toContain(outcomeC);
    expect(await rp.content()).not.toContain("The receipt records the purchase.");
    expect(await rp.content()).not.toContain("The receipt documents the purchase price for this item.");
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

test("a designated approver can discover and sign off on an agent proposal", async ({ browser }) => {
  test.setTimeout(120_000);
  const locale = "fr-CA";
  const approvalProgramEnv = { ...PROGRAM_ENV, AEQUITAS_CASE_AGENT_CONSENT_ONLY_RESOLUTION: "false" };
  const approvalEnv = {
    ...approvalProgramEnv,
    AEQUITAS_CASE_AGENT_EVALUATION_REVIEWED_FOR: caseAgentEvaluationApprovalIdentity(approvalProgramEnv) ?? "",
  };
  const messages = fr;
  if (!(await prisma.user.findFirst({ where: { globalRole: "CASE_AGENT" } }))) {
    await prisma.user.create({ data: { email: `case-agent-${randomUUID()}@aequitas.invalid`, displayName: "Automated assistant", globalRole: "CASE_AGENT" } });
  }
  const mk = (label: string, globalRole: "COMPLAINANT" | "RESPONDENT" | "CASE_MANAGER", isApprover = false) =>
    prisma.user.create({ data: { email: `agent-approval-e2e-${label}-${randomUUID()}@example.org`, displayName: `Approval ${label}`, globalRole, locale, isApprover } });
  const [c, r, manager, approver, ordinaryManager] = await Promise.all([
    mk("complainant", "COMPLAINANT"),
    mk("respondent", "RESPONDENT"),
    mk("owner", "CASE_MANAGER"),
    mk("approver", "CASE_MANAGER", true),
    mk("ordinary-manager", "CASE_MANAGER"),
  ]);
  await prisma.webAuthnCredential.create({ data: { userId: approver.id, credentialId: randomUUID(), publicKey: Buffer.from("synthetic"), counter: 0n, transports: [] } });
  const statement = await prisma.consentStatementVersion.create({ data: { version: Number.parseInt(randomUUID().replaceAll("-", "").slice(0, 8), 16) % 2_000_000_000, locale, body: "Synthetic.", effectiveFrom: new Date() } });
  const referenceNumber = `AE-AGENT-APPROVAL-${randomUUID().slice(0, 8)}`;
  const created = await createCase({ actorId: c.id, actorRole: "COMPLAINANT", referenceNumber, complainantId: c.id, respondentId: r.id, simulated: true, category: "RETAIL", amountAtStakeCents: 5000, disputeDescription: "Synthetic kettle dispute.", requestedStatementVersionId: statement.id, currentStatementVersionId: statement.id });
  if (!created.ok) throw new Error(created.reason);
  const caseId = created.data.caseId;
  await submitCase({ actorId: c.id, actorRole: "COMPLAINANT", caseId });
  await openIntake({ actorId: manager.id, actorRole: "CASE_MANAGER", caseId, hasConflict: false });
  const evidence = [
    { party: c, text: "Receipt: kettle purchase $89.99 on 2026-10-02.", excerpt: "kettle purchase $89.99 on 2026-10-02" },
    { party: r, text: "Store note: repair voucher offered on 2026-10-05.", excerpt: "repair voucher offered on 2026-10-05" },
  ];
  const ids: string[] = [];
  for (const { party, text } of evidence) {
    const id = randomUUID();
    const stored = await uploadEvidence({ caseId, evidenceId: id, simulated: true, buffer: Buffer.from(text), mimeType: "text/plain" });
    await prisma.evidenceItem.create({ data: { id, caseId, submittedById: party.id, kind: "RECEIPT", title: `Synthetic ${party.globalRole} file`, ...stored, mimeType: "text/plain", scanStatus: "CLEAN", simulated: true } });
    ids.push(id);
  }
  await closeIntake({ actorId: manager.id, actorRole: "CASE_MANAGER", caseId });
  await submitPosition({ actorId: c.id, actorRole: "COMPLAINANT", caseId, body: "Synthetic buyer position.", locale });
  await submitPosition({ actorId: r.id, actorRole: "RESPONDENT", caseId, body: "Synthetic seller position.", locale: "en-CA" });
  const enrolled = await enrollCaseAgent({ actorId: manager.id, actorRole: "CASE_MANAGER", caseId }, approvalEnv);
  if (!enrolled.ok) throw new Error(enrolled.reason);
  const configured = caseAgentProgram(approvalEnv);
  if (!configured.ok) throw new Error(`Synthetic program is missing: ${configured.missing.join(", ")}`);
  for (const [party, role, partyLocale] of [[c, "COMPLAINANT", "fr-CA"], [r, "RESPONDENT", "en-CA"]] as const) {
    const choice = await acceptCaseAgentProcessing({ actorId: party.id, actorRole: role, caseId, noticeHash: configured.program.processingDisclosure.noticeHash, locale: partyLocale }, approvalEnv);
    if (!choice.ok) throw new Error(choice.reason);
  }
  const savedResendKey = process.env.RESEND_API_KEY;
  process.env.RESEND_API_KEY = "";
  let run: Awaited<ReturnType<typeof runCaseAgent>>;
  try {
    run = await runCaseAgent({
      caseId,
      env: approvalEnv,
      model: { provider: "test", model: "stub", complete: async () => JSON.stringify({
        needs_human: null,
        summary_claims: [{ text: "The receipt records the purchase.", citation_ids: ["C1"] }, { text: "The store note records the offered remedy.", citation_ids: ["C2"] }],
        reasoning_claims: [{ text: "The records describe different parts of the exchange.", citation_ids: ["C1", "C2"] }],
        limits: ["Limit."], not_considered: ["Other losses."],
        citations: [
          { citation_id: "C1", evidence_item_id: ids[0], relevance: "Receipt documents the purchase.", excerpt: evidence[0].excerpt },
          { citation_id: "C2", evidence_item_id: ids[1], relevance: "Store note records the offered remedy.", excerpt: evidence[1].excerpt },
        ],
        proposal: { remedy: "repair", amount_cents: null, rationale_claims: [{ text: "The receipt documents the purchase price for this item.", citation_ids: ["C1"] }] },
        party_evidence: { complainant: [ids[0]], respondent: [ids[1]] },
      }) },
    });
  } finally {
    if (savedResendKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = savedResendKey;
  }
  expect(run.status).toBe("issued");
  const approvalNotices = await prisma.notification.findMany({ where: { caseId, kind: RECOMMENDATION_APPROVAL_REQUIRED_KIND }, select: { userId: true } });
  expect(approvalNotices.map((notice) => notice.userId)).toContain(approver.id);
  expect(approvalNotices.map((notice) => notice.userId)).not.toContain(manager.id);
  expect(approvalNotices.map((notice) => notice.userId)).not.toContain(ordinaryManager.id);

  const [approverContext, ordinaryContext, managerContext] = await Promise.all([
    contextFor(browser, approver.id, "CASE_MANAGER"),
    contextFor(browser, ordinaryManager.id, "CASE_MANAGER"),
    contextFor(browser, manager.id, "CASE_MANAGER"),
  ]);
  const [approverPage, ordinaryPage, managerPage] = await Promise.all([approverContext.newPage(), ordinaryContext.newPage(), managerContext.newPage()]);
  const caseHref = `/${locale}/cases/${caseId}`;
  await Promise.all([approverPage.goto(`/${locale}/cases`), ordinaryPage.goto(`/${locale}/cases`), managerPage.goto(caseHref)]);
  const approvalCard = approverPage.locator(`a[href="${caseHref}"]`);
  await expect(approvalCard).toContainText(referenceNumber);
  await expect(approvalCard).toContainText(messages.caseList.approvalNeeded);
  await expect(ordinaryPage.locator(`a[href="${caseHref}"]`)).toHaveCount(0);
  await expect(managerPage.locator("#approve-resolution")).toHaveCount(0);

  await approvalCard.click();
  const copy = messages.workspace.resolution;
  await expect(approverPage.getByRole("heading", { name: copy.title })).toBeVisible();
  await approverPage.getByLabel(copy.rationaleLabel).fill("I independently reviewed the issued proposal and current file.");
  const approvalResponse = approverPage.waitForResponse((response) => new URL(response.url()).pathname === `/api/cases/${caseId}/approval` && response.request().method() === "POST");
  await approverPage.getByRole("button", { name: copy.approveButton }).click();
  expect((await approvalResponse).ok()).toBe(true);
  await expect(approverPage.locator("#resolution-approval")).toContainText("I independently reviewed the issued proposal and current file.");
  await approverPage.goto(`/${locale}/cases`);
  await expect(approverPage.locator(`a[href="${caseHref}"]`)).toHaveCount(0);
  await Promise.all([approverContext.close(), ordinaryContext.close(), managerContext.close()]);
});
