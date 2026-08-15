import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../src/lib/prisma";
import {
  closeIntake,
  completeDraft,
  createCase,
  issueRecommendation,
  openIntake,
  requestDraft,
  submitCase,
  submitEvidence,
  submitPosition,
} from "../../src/domain/mutate";
import type { ExplanationRecord } from "../../src/domain/explanationRecord";

const BENIGN = Buffer.from("A genuine evidence document, nothing suspicious here.");

let complainantId: string;
let respondentId: string;
let managerId: string;
let otherManagerId: string;
let statementVersionId: string;

beforeAll(async () => {
  const [consumer, retailer, manager, otherManager, statementVersion] = await Promise.all([
    prisma.user.create({ data: { email: `rec-consumer-${randomUUID()}@example.com`, displayName: "Rec Consumer", globalRole: "COMPLAINANT" } }),
    prisma.user.create({ data: { email: `rec-retailer-${randomUUID()}@example.com`, displayName: "Rec Retailer", globalRole: "RESPONDENT" } }),
    prisma.user.create({ data: { email: `rec-manager-${randomUUID()}@example.com`, displayName: "Rec Manager", globalRole: "CASE_MANAGER" } }),
    prisma.user.create({ data: { email: `rec-manager2-${randomUUID()}@example.com`, displayName: "Rec Other Manager", globalRole: "CASE_MANAGER" } }),
    prisma.consentStatementVersion.create({
      data: { version: Date.now() % 1_000_000, locale: "fr-CA", body: "Test.", effectiveFrom: new Date() },
    }),
  ]);
  complainantId = consumer.id;
  respondentId = retailer.id;
  managerId = manager.id;
  otherManagerId = otherManager.id;
  statementVersionId = statementVersion.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function freshPositionsCase(): Promise<string> {
  const created = await createCase({
    actorId: complainantId,
    actorRole: "COMPLAINANT",
    referenceNumber: `AE-REC-${randomUUID().slice(0, 8)}`,
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

  const consumerEvidence = await submitEvidence({
    actorId: complainantId,
    actorRole: "COMPLAINANT",
    caseId,
    kind: "DOCUMENT",
    title: "Consumer evidence",
    buffer: BENIGN,
    mimeType: "text/plain",
  });
  const retailerEvidence = await submitEvidence({
    actorId: respondentId,
    actorRole: "RESPONDENT",
    caseId,
    kind: "DOCUMENT",
    title: "Retailer evidence",
    buffer: BENIGN,
    mimeType: "text/plain",
  });
  if (!consumerEvidence.ok || !retailerEvidence.ok) throw new Error("setup: submitEvidence failed");

  const closed = await closeIntake({ actorId: managerId, actorRole: "CASE_MANAGER", caseId });
  if (!closed.ok) throw new Error("setup: closeIntake failed");

  const consumerPosition = await submitPosition({ actorId: complainantId, actorRole: "COMPLAINANT", caseId, body: "Consumer position.", locale: "fr-CA" });
  const retailerPosition = await submitPosition({
    actorId: respondentId,
    actorRole: "RESPONDENT",
    caseId,
    body: "Retailer position.",
    locale: "fr-CA",
  });
  if (!consumerPosition.ok || !retailerPosition.ok) throw new Error("setup: submitPosition failed");

  return caseId;
}

async function freshDraftingCase(): Promise<string> {
  const caseId = await freshPositionsCase();
  const requested = await requestDraft({ actorId: managerId, actorRole: "CASE_MANAGER", caseId });
  if (!requested.ok) throw new Error("setup: requestDraft failed");
  return caseId;
}

/**
 * No ANTHROPIC_API_KEY exists in this environment (see DECISIONS.md M3) —
 * completeDraft() therefore always takes its real, live "AI unavailable"
 * failure path here, never a mocked one. issueRecommendation() needs a
 * genuinely valid Recommendation row to test against, which nothing in
 * this environment can produce live; this seeds one by hand, citing the
 * case's own real evidence IDs, standing in for what a successful
 * completeDraft() call would have written. This is providing a
 * precondition for the function under test, not mocking the function
 * itself — issueRecommendation() runs for real against real DB state.
 */
async function seedValidDraftRecommendation(caseId: string): Promise<{ recommendationId: string }> {
  const evidenceItems = await prisma.evidenceItem.findMany({ where: { caseId, scanStatus: "CLEAN" } });
  const explanation: ExplanationRecord = {
    summary: "The product arrived damaged and the retailer declined a refund despite a timely, documented request.",
    proposed_outcome: "The retailer issues a full refund for the damaged item.",
    reasoning: "The consumer's evidence documents the defect; the retailer's evidence does not dispute that the item arrived damaged.",
    evidence_citations: evidenceItems.map((e) => ({ evidence_item_id: e.id, relevance: "Cited evidence." })),
    limits: ["This does not independently verify the item's condition prior to shipping."],
    not_considered: ["Correspondence between the parties outside this case record was not considered."],
    model: { id: "claude-opus-5", prompt_version: "2026-08-15.1" },
    reviewer: { user_id: null, issued_at: null },
  };
  const recommendation = await prisma.recommendation.create({
    data: {
      caseId,
      version: 1,
      status: "DRAFT",
      explanation: explanation as unknown as import("../../src/generated/prisma").Prisma.InputJsonValue,
      modelId: explanation.model.id,
      promptVersion: explanation.model.prompt_version,
    },
  });
  await prisma.case.update({ where: { id: caseId }, data: { currentRecommendationId: recommendation.id } });
  return { recommendationId: recommendation.id };
}

describe("requestDraft — role, assignment, and precondition enforcement", () => {
  it("rejects a non-CASE_MANAGER caller at the authorize-role step", async () => {
    const caseId = await freshPositionsCase();
    const result = await requestDraft({ actorId: complainantId, actorRole: "COMPLAINANT", caseId });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.step).toBe("authorize-role");
  });

  it("rejects a case manager who is not assigned to this case as not-found", async () => {
    const caseId = await freshPositionsCase();
    const result = await requestDraft({ actorId: otherManagerId, actorRole: "CASE_MANAGER", caseId });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.step).toBe("not-found");
  });

  it("blocks the request when a party has no current position", async () => {
    const created = await createCase({
      actorId: complainantId,
      actorRole: "COMPLAINANT",
      referenceNumber: `AE-REC-${randomUUID().slice(0, 8)}`,
      complainantId,
      respondentId,
      simulated: true,
      requestedStatementVersionId: statementVersionId,
      currentStatementVersionId: statementVersionId,
    });
    if (!created.ok) throw new Error("setup failed");
    const caseId = created.data.caseId;
    const submitted = await submitCase({ actorId: complainantId, actorRole: "COMPLAINANT", caseId });
    if (!submitted.ok) throw new Error("setup failed");
    const opened = await openIntake({ actorId: managerId, actorRole: "CASE_MANAGER", caseId, hasConflict: false });
    if (!opened.ok) throw new Error("setup failed");
    const closed = await closeIntake({ actorId: managerId, actorRole: "CASE_MANAGER", caseId, overrideReason: "test fixture" });
    if (!closed.ok) throw new Error("setup failed");
    // Neither party has submitted a position yet.

    const result = await requestDraft({ actorId: managerId, actorRole: "CASE_MANAGER", caseId });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.step).toBe("guard");
  });

  it("succeeds and transitions POSITIONS -> DRAFTING once both parties have current positions", async () => {
    const caseId = await freshPositionsCase();
    const result = await requestDraft({ actorId: managerId, actorRole: "CASE_MANAGER", caseId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.eventPayloads[0]).toMatchObject({ type: "RECOMMENDATION_DRAFT_REQUESTED" });

    const caseRow = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
    expect(caseRow.state).toBe("DRAFTING");
  });
});

describe("completeDraft — real failure path (no ANTHROPIC_API_KEY in this environment)", () => {
  it("rejects at the guard step and writes no Recommendation row when the AI is unavailable", async () => {
    const caseId = await freshDraftingCase();

    const result = await completeDraft({ caseId });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.step).toBe("guard");
    expect(result.reason).toMatch(/ANTHROPIC_API_KEY|AI/i);

    // Section 9: "Validation failure = draft rejected, event
    // recommendation.drafted is not emitted."
    const recommendations = await prisma.recommendation.findMany({ where: { caseId } });
    expect(recommendations).toHaveLength(0);
    const events = await prisma.event.findMany({ where: { caseId, type: "RECOMMENDATION_DRAFTED" } });
    expect(events).toHaveLength(0);

    const caseRow = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
    expect(caseRow.state).toBe("DRAFTING");
    expect(caseRow.currentRecommendationId).toBeNull();
  });
});

describe("issueRecommendation — role, assignment, checklist-adjacent guards, and quarantine", () => {
  it("rejects a non-CASE_MANAGER caller at the authorize-role step", async () => {
    const caseId = await freshDraftingCase();
    await seedValidDraftRecommendation(caseId);

    const result = await issueRecommendation({ actorId: complainantId, actorRole: "COMPLAINANT", caseId });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.step).toBe("authorize-role");
  });

  it("rejects a case manager who is not assigned to this case as not-found (also covers reviewerIsIssuingManager)", async () => {
    const caseId = await freshDraftingCase();
    await seedValidDraftRecommendation(caseId);

    const result = await issueRecommendation({ actorId: otherManagerId, actorRole: "CASE_MANAGER", caseId });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.step).toBe("not-found");
  });

  it("rejects when the recommendation cites evidence not in this case", async () => {
    const caseId = await freshDraftingCase();
    const { recommendationId } = await seedValidDraftRecommendation(caseId);
    // Corrupt the citation to point at an evidence item that doesn't exist.
    const explanation = (await prisma.recommendation.findUniqueOrThrow({ where: { id: recommendationId } })).explanation as ExplanationRecord;
    await prisma.recommendation.update({
      where: { id: recommendationId },
      data: {
        explanation: {
          ...explanation,
          evidence_citations: [{ evidence_item_id: randomUUID(), relevance: "Not actually in this case." }],
        } as unknown as import("../../src/generated/prisma").Prisma.InputJsonValue,
      },
    });

    const result = await issueRecommendation({ actorId: managerId, actorRole: "CASE_MANAGER", caseId });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.step).toBe("guard");
    expect(result.reason).toMatch(/cites evidence not in this case/);
  });

  it("succeeds, sets reviewer/issuedAt, and transitions DRAFTING -> ISSUED", async () => {
    const caseId = await freshDraftingCase();
    const { recommendationId } = await seedValidDraftRecommendation(caseId);

    const result = await issueRecommendation({ actorId: managerId, actorRole: "CASE_MANAGER", caseId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.eventPayloads[0]).toMatchObject({ type: "RECOMMENDATION_ISSUED" });

    const caseRow = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
    expect(caseRow.state).toBe("ISSUED");

    const recommendation = await prisma.recommendation.findUniqueOrThrow({ where: { id: recommendationId } });
    expect(recommendation.status).toBe("ISSUED");
    expect(recommendation.issuedById).toBe(managerId);
    expect(recommendation.issuedAt).not.toBeNull();
    const explanation = recommendation.explanation as ExplanationRecord;
    expect(explanation.reviewer.user_id).toBe(managerId);
    expect(explanation.reviewer.issued_at).not.toBeNull();

    // Both parties notified (Section 6 row 10: "recommendation.issued, party.notified (both)").
    const notifications = await prisma.notification.findMany({ where: { caseId, kind: "recommendation_issued" } });
    expect(notifications.map((n) => n.userId).sort()).toEqual([complainantId, respondentId].sort());
  });
});
