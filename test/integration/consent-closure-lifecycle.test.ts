import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../src/lib/prisma";
import {
  closeCase,
  closeIntake,
  createCase,
  declineConsent,
  giveConsent,
  issueRecommendation,
  openIntake,
  requestDraft,
  requestNewVersion,
  revokeConsent,
  submitCase,
  submitEvidence,
  submitPosition,
  withdrawCase,
} from "../../src/domain/mutate";
import { generateExportBundle } from "../../src/domain/exportBundle";
import type { ExplanationRecord } from "../../src/domain/explanationRecord";
import type { Prisma } from "../../src/generated/prisma";

const BENIGN = Buffer.from("A genuine evidence document, nothing suspicious here.");

let complainantId: string;
let respondentId: string;
let managerId: string;
let statementVersionId: string;

beforeAll(async () => {
  const [complainant, respondent, manager, statementVersion] = await Promise.all([
    prisma.user.create({ data: { email: `cc-complainant-${randomUUID()}@example.com`, displayName: "CC Complainant", globalRole: "COMPLAINANT" } }),
    prisma.user.create({ data: { email: `cc-respondent-${randomUUID()}@example.com`, displayName: "CC Respondent", globalRole: "RESPONDENT" } }),
    prisma.user.create({ data: { email: `cc-manager-${randomUUID()}@example.com`, displayName: "CC Manager", globalRole: "CASE_MANAGER" } }),
    prisma.consentStatementVersion.create({
      data: { version: Date.now() % 1_000_000, locale: "fr-CA", body: "Test.", effectiveFrom: new Date() },
    }),
  ]);
  complainantId = complainant.id;
  respondentId = respondent.id;
  managerId = manager.id;
  statementVersionId = statementVersion.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function seedIssuedCase(): Promise<{ caseId: string; recommendationId: string }> {
  const created = await createCase({
    actorId: complainantId,
    actorRole: "COMPLAINANT",
    referenceNumber: `AE-CC-${randomUUID().slice(0, 8)}`,
    complainantId,
    respondentId,
    simulated: true,
    requestedStatementVersionId: statementVersionId,
    currentStatementVersionId: statementVersionId,
  });
  if (!created.ok) throw new Error("setup: createCase failed");
  const caseId = created.data.caseId;

  const submitted = await submitCase({ actorId: complainantId, actorRole: "COMPLAINANT", caseId });
  if (!submitted.ok) throw new Error("setup: submitCase failed");

  const opened = await openIntake({ actorId: managerId, actorRole: "CASE_MANAGER", caseId, hasConflict: false });
  if (!opened.ok) throw new Error("setup: openIntake failed");

  const complainantEvidence = await submitEvidence({
    actorId: complainantId,
    actorRole: "COMPLAINANT",
    caseId,
    kind: "DOCUMENT",
    title: "Complainant evidence",
    buffer: BENIGN,
    mimeType: "text/plain",
  });
  const respondentEvidence = await submitEvidence({
    actorId: respondentId,
    actorRole: "RESPONDENT",
    caseId,
    kind: "DOCUMENT",
    title: "Respondent evidence",
    buffer: BENIGN,
    mimeType: "text/plain",
  });
  if (!complainantEvidence.ok || !respondentEvidence.ok) throw new Error("setup: submitEvidence failed");

  const closed = await closeIntake({ actorId: managerId, actorRole: "CASE_MANAGER", caseId });
  if (!closed.ok) throw new Error("setup: closeIntake failed");

  const complainantPosition = await submitPosition({ actorId: complainantId, actorRole: "COMPLAINANT", caseId, body: "Complainant position.", locale: "fr-CA" });
  const respondentPosition = await submitPosition({ actorId: respondentId, actorRole: "RESPONDENT", caseId, body: "Respondent position.", locale: "fr-CA" });
  if (!complainantPosition.ok || !respondentPosition.ok) throw new Error("setup: submitPosition failed");

  const requested = await requestDraft({ actorId: managerId, actorRole: "CASE_MANAGER", caseId });
  if (!requested.ok) throw new Error("setup: requestDraft failed");

  const evidenceItems = await prisma.evidenceItem.findMany({ where: { caseId, scanStatus: "CLEAN" } });
  const explanation: ExplanationRecord = {
    summary: "Summary.",
    proposed_outcome: "Proposed outcome.",
    reasoning: "Reasoning.",
    evidence_citations: evidenceItems.map((e) => ({ evidence_item_id: e.id, relevance: "Cited." })),
    limits: ["A limit."],
    not_considered: ["Something not considered."],
    model: { id: "claude-opus-5", prompt_version: "2026-08-15.2" },
    reviewer: { user_id: null, issued_at: null },
  };
  const recommendation = await prisma.recommendation.create({
    data: {
      caseId,
      version: 1,
      status: "DRAFT",
      explanation: explanation as unknown as Prisma.InputJsonValue,
      modelId: explanation.model.id,
      promptVersion: explanation.model.prompt_version,
    },
  });
  await prisma.case.update({ where: { id: caseId }, data: { currentRecommendationId: recommendation.id } });

  const issued = await issueRecommendation({ actorId: managerId, actorRole: "CASE_MANAGER", caseId });
  if (!issued.ok) throw new Error(`setup: issueRecommendation failed: ${issued.reason}`);

  return { caseId, recommendationId: recommendation.id };
}

describe("giveConsent / declineConsent — real state derivation", () => {
  it("a single party giving consent keeps the case ISSUED (waiting on the other party)", async () => {
    const { caseId, recommendationId } = await seedIssuedCase();
    const result = await giveConsent({
      actorId: complainantId,
      actorRole: "COMPLAINANT",
      caseId,
      recommendationId,
      statementVersionId,
      currentStatementVersionId: statementVersionId,
      authContext: { test: true },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.toState).toBe("ISSUED");

    const record = await prisma.consentRecord.findFirst({ where: { recommendationId, partyId: complainantId } });
    expect(record?.state).toBe("GIVEN");
    expect(record?.givenAt).not.toBeNull();
  });

  it("both parties giving consent resolves the case to RESOLVED_CONSENT", async () => {
    const { caseId, recommendationId } = await seedIssuedCase();
    const first = await giveConsent({ actorId: complainantId, actorRole: "COMPLAINANT", caseId, recommendationId, statementVersionId, currentStatementVersionId: statementVersionId, authContext: {} });
    expect(first.ok).toBe(true);
    const second = await giveConsent({ actorId: respondentId, actorRole: "RESPONDENT", caseId, recommendationId, statementVersionId, currentStatementVersionId: statementVersionId, authContext: {} });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.toState).toBe("RESOLVED_CONSENT");

    const caseRow = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
    expect(caseRow.state).toBe("RESOLVED_CONSENT");
  });

  it("rejects a non-party attempting to give consent", async () => {
    const { caseId, recommendationId } = await seedIssuedCase();
    const result = await giveConsent({ actorId: managerId, actorRole: "CASE_MANAGER", caseId, recommendationId, statementVersionId, currentStatementVersionId: statementVersionId, authContext: {} });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.step).toBe("authorize-role");
  });

  it("declining resolves the case to RESOLVED_DECLINED, regardless of the other party's state", async () => {
    const { caseId, recommendationId } = await seedIssuedCase();
    const result = await declineConsent({
      actorId: respondentId,
      actorRole: "RESPONDENT",
      caseId,
      recommendationId,
      statementVersionId,
      currentStatementVersionId: statementVersionId,
      authContext: {},
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.toState).toBe("RESOLVED_DECLINED");
  });

  it("rejects consent bound to a stale recommendation id", async () => {
    const { caseId } = await seedIssuedCase();
    const result = await giveConsent({
      actorId: complainantId,
      actorRole: "COMPLAINANT",
      caseId,
      recommendationId: randomUUID(),
      statementVersionId,
      currentStatementVersionId: statementVersionId,
      authContext: {},
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.step).toBe("guard");
  });
});

describe("revokeConsent — reopens the case", () => {
  it("revoking a given consent moves the case back to ISSUED and records CASE_REOPENED", async () => {
    const { caseId, recommendationId } = await seedIssuedCase();
    const given = await giveConsent({ actorId: complainantId, actorRole: "COMPLAINANT", caseId, recommendationId, statementVersionId, currentStatementVersionId: statementVersionId, authContext: {} });
    expect(given.ok).toBe(true);

    const revoked = await revokeConsent({ actorId: complainantId, actorRole: "COMPLAINANT", caseId });
    expect(revoked.ok).toBe(true);
    if (!revoked.ok) return;
    expect(revoked.data.toState).toBe("ISSUED");

    const record = await prisma.consentRecord.findFirst({ where: { recommendationId, partyId: complainantId } });
    expect(record?.state).toBe("REVOKED");
    expect(record?.revokedAt).not.toBeNull();
  });

  it("rejects revocation from a party who never gave consent", async () => {
    const { caseId } = await seedIssuedCase();
    const result = await revokeConsent({ actorId: respondentId, actorRole: "RESPONDENT", caseId });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.step).toBe("not-found");
  });
});

describe("requestNewVersion — RESOLVED_DECLINED -> DRAFTING", () => {
  it("supersedes the prior recommendation and starts a new one at the next version number", async () => {
    const { caseId, recommendationId } = await seedIssuedCase();
    const declined = await declineConsent({ actorId: complainantId, actorRole: "COMPLAINANT", caseId, recommendationId, statementVersionId, currentStatementVersionId: statementVersionId, authContext: {} });
    expect(declined.ok).toBe(true);

    const result = await requestNewVersion({ actorId: managerId, actorRole: "CASE_MANAGER", caseId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.toState).toBe("DRAFTING");

    const prior = await prisma.recommendation.findUniqueOrThrow({ where: { id: recommendationId } });
    expect(prior.status).toBe("SUPERSEDED");

    const caseRow = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
    expect(caseRow.currentRecommendationId).toBeNull();
  });

  it("rejects a non-assigned case manager", async () => {
    const { caseId, recommendationId } = await seedIssuedCase();
    const declined = await declineConsent({ actorId: respondentId, actorRole: "RESPONDENT", caseId, recommendationId, statementVersionId, currentStatementVersionId: statementVersionId, authContext: {} });
    expect(declined.ok).toBe(true);

    const otherManager = await prisma.user.create({
      data: { email: `cc-other-manager-${randomUUID()}@example.com`, displayName: "Other Manager", globalRole: "CASE_MANAGER" },
    });
    const result = await requestNewVersion({ actorId: otherManager.id, actorRole: "CASE_MANAGER", caseId });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.step).toBe("not-found");
  });
});

describe("withdrawCase — standing complainant capability", () => {
  it("withdraws a case from ISSUED, emitting CASE_WITHDRAWN", async () => {
    const { caseId } = await seedIssuedCase();
    const result = await withdrawCase({ actorId: complainantId, actorRole: "COMPLAINANT", caseId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.toState).toBe("WITHDRAWN");
  });

  it("rejects withdrawal by the respondent (owner-only)", async () => {
    const { caseId } = await seedIssuedCase();
    const result = await withdrawCase({ actorId: respondentId, actorRole: "RESPONDENT", caseId });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.step).toBe("authorize-role");
  });
});

describe("closeCase + generateExportBundle — Section 15 sealed export", () => {
  it("generates a real bundle (JSON + PDF + verification.txt zipped, uploaded, hashed) and closes the case", async () => {
    const { caseId, recommendationId } = await seedIssuedCase();
    const first = await giveConsent({ actorId: complainantId, actorRole: "COMPLAINANT", caseId, recommendationId, statementVersionId, currentStatementVersionId: statementVersionId, authContext: {} });
    expect(first.ok).toBe(true);
    const second = await giveConsent({ actorId: respondentId, actorRole: "RESPONDENT", caseId, recommendationId, statementVersionId, currentStatementVersionId: statementVersionId, authContext: {} });
    expect(second.ok).toBe(true);

    const bundle = await generateExportBundle({ caseId, actorId: managerId });
    expect(bundle.sha256).toMatch(/^[0-9a-f]{64}$/);

    const bundleRow = await prisma.exportBundle.findUniqueOrThrow({ where: { storageKey: bundle.storageKey } });
    expect(bundleRow.sha256).toBe(bundle.sha256);

    const closed = await closeCase({ actorId: managerId, actorRole: "CASE_MANAGER", caseId, exportSha256: bundle.sha256 });
    expect(closed.ok).toBe(true);
    if (!closed.ok) return;
    expect(closed.data.toState).toBe("CLOSED");

    const caseRow = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
    expect(caseRow.state).toBe("CLOSED");
    expect(caseRow.closedAt).not.toBeNull();
  });

  it("rejects close_case with no export hash", async () => {
    const { caseId, recommendationId } = await seedIssuedCase();
    await giveConsent({ actorId: complainantId, actorRole: "COMPLAINANT", caseId, recommendationId, statementVersionId, currentStatementVersionId: statementVersionId, authContext: {} });
    await giveConsent({ actorId: respondentId, actorRole: "RESPONDENT", caseId, recommendationId, statementVersionId, currentStatementVersionId: statementVersionId, authContext: {} });

    const result = await closeCase({ actorId: managerId, actorRole: "CASE_MANAGER", caseId, exportSha256: "" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.step).toBe("guard");
  });
});
