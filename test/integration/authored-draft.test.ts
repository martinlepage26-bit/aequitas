import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// No model may be called on this path. If anything reaches the drafting
// client, the test fails loudly instead of making a network request.
const draftSpy = vi.hoisted(() => vi.fn(() => { throw new Error("The model client must not be called by author_draft."); }));
vi.mock("../../src/ai/draftRecommendation", () => ({ draftRecommendation: draftSpy }));

import { prisma } from "../../src/lib/prisma";
import {
  closeCase,
  closeIntake,
  createCase,
  giveConsent,
  issueRecommendation,
  mutationFailureResponse,
  openIntake,
  submitCase,
  submitEvidence,
  submitPosition,
} from "../../src/domain/mutate";
import { authorDraft } from "../../src/domain/authoredDraft";
import { approveResolution } from "../../src/domain/resolution";
import { issuePartyOutcome, readPartyOutcomes } from "../../src/domain/partyOutcome";
import { generateExportBundle, buildExportRecord } from "../../src/domain/exportBundle";
import { HUMAN_AUTHORED_MODEL_ID, HUMAN_AUTHORED_PROMPT_VERSION } from "../../src/domain/humanAuthored";
import { verifyCase } from "../../src/domain/verifyEvents";
import { RECOMMENDATION_APPROVAL_REQUIRED_KIND } from "../../src/lib/mail";

/**
 * A pilot program must be able to complete a case with no model configured.
 * This walks the synthetic journey from positions through a draft written by
 * the assigned case manager, issuance, approver sign-off, both consents, the
 * sealed export and closure, and checks who is refused at each new step.
 *
 * Scanning: this suite stands up a loopback stand-in that answers clamd's
 * INSTREAM protocol with "OK". It exercises the real intake mutations; it
 * does not test ClamAV itself (see the evidence scanning suites for that).
 */

const BENIGN = Buffer.from("Synthetic pilot evidence. No real case data.");

let clamd: Server;
let storageDir: string;
let complainantId: string;
let respondentId: string;
let managerId: string;
let otherManagerId: string;
let approverId: string;
let adminId: string;
let statementVersionId: string;

const validFields = (citations: Array<{ evidence_item_id: string; relevance: string }> = []) => ({
  summary: "The buyer reports a late delivery; the seller reports a carrier delay outside its control.",
  proposed_outcome: "The seller refunds the shipping fee and both parties confirm the order is otherwise complete.",
  reasoning: "Both positions agree the parcel arrived nine days late. They differ on responsibility for the carrier delay.",
  evidence_citations: citations,
  limits: ["The carrier's own records were not provided."],
  not_considered: ["Any loss beyond the shipping fee."],
});

beforeAll(async () => {
  storageDir = mkdtempSync(path.join(tmpdir(), "aeq-authored-"));
  process.env.STORAGE_LOCAL_DIR = storageDir;
  clamd = createServer(socket => {
    let received = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      if (received.byteLength >= 4 && received.subarray(-4).equals(Buffer.alloc(4))) socket.end("stream: OK\n");
    });
  });
  await new Promise<void>(resolve => clamd.listen(0, "127.0.0.1", resolve));
  const address = clamd.address();
  if (!address || typeof address === "string") throw new Error("setup: stand-in scanner did not bind");
  process.env.CLAMAV_HOST = "127.0.0.1";
  process.env.CLAMAV_PORT = String(address.port);

  const mk = (label: string, globalRole: "COMPLAINANT" | "RESPONDENT" | "CASE_MANAGER" | "ADMIN", isApprover = false) =>
    prisma.user.create({ data: { email: `authored-${label}-${randomUUID()}@example.com`, displayName: `Authored ${label}`, globalRole, isApprover } });
  const [c, r, m, om, a, ad] = await Promise.all([
    mk("complainant", "COMPLAINANT"), mk("respondent", "RESPONDENT"), mk("manager", "CASE_MANAGER"),
    mk("other-manager", "CASE_MANAGER"), mk("approver", "CASE_MANAGER", true), mk("admin", "ADMIN"),
  ]);
  [complainantId, respondentId, managerId, otherManagerId, approverId, adminId] = [c.id, r.id, m.id, om.id, a.id, ad.id];
  await prisma.webAuthnCredential.create({ data: { userId: approverId, credentialId: randomUUID(), publicKey: Buffer.from("synthetic"), counter: 0n, transports: [] } });
  const statement = await prisma.consentStatementVersion.create({
    data: { version: Number.parseInt(randomUUID().replaceAll("-", "").slice(0, 8), 16) % 2_000_000_000, locale: "fr-CA", body: "Énoncé de consentement synthétique.", effectiveFrom: new Date() },
  });
  statementVersionId = statement.id;
});

afterAll(async () => {
  await new Promise<void>(resolve => clamd.close(() => resolve()));
  rmSync(storageDir, { recursive: true, force: true });
  await prisma.$disconnect();
});

async function caseAtIntake(): Promise<{ caseId: string; evidenceIds: string[] }> {
  const created = await createCase({
    actorId: complainantId, actorRole: "COMPLAINANT", referenceNumber: `AE-AUTH-${randomUUID().slice(0, 8)}`,
    complainantId, respondentId, simulated: true, category: "RETAIL",
    disputeDescription: "Synthetic pilot dispute about a late delivery.",
    requestedStatementVersionId: statementVersionId, currentStatementVersionId: statementVersionId,
  });
  if (!created.ok) throw new Error(`setup: createCase failed: ${created.reason}`);
  const caseId = created.data.caseId;
  if (!(await submitCase({ actorId: complainantId, actorRole: "COMPLAINANT", caseId })).ok) throw new Error("setup: submitCase failed");
  if (!(await openIntake({ actorId: managerId, actorRole: "CASE_MANAGER", caseId, hasConflict: false })).ok) throw new Error("setup: openIntake failed");
  for (const [actorId, actorRole, title] of [[complainantId, "COMPLAINANT", "Order receipt"], [respondentId, "RESPONDENT", "Carrier notice"]] as const) {
    const submitted = await submitEvidence({ actorId, actorRole, caseId, kind: "DOCUMENT", title, buffer: BENIGN, mimeType: "text/plain" });
    if (!submitted.ok) throw new Error(`setup: submitEvidence failed: ${submitted.reason}`);
  }
  const evidence = await prisma.evidenceItem.findMany({ where: { caseId, scanStatus: "CLEAN" }, orderBy: { createdAt: "asc" } });
  return { caseId, evidenceIds: evidence.map(e => e.id) };
}

async function caseAtPositions() {
  const setup = await caseAtIntake();
  if (!(await closeIntake({ actorId: managerId, actorRole: "CASE_MANAGER", caseId: setup.caseId })).ok) throw new Error("setup: closeIntake failed");
  const a = await submitPosition({ actorId: complainantId, actorRole: "COMPLAINANT", caseId: setup.caseId, body: "Le colis est arrivé avec neuf jours de retard.", locale: "fr-CA" });
  const b = await submitPosition({ actorId: respondentId, actorRole: "RESPONDENT", caseId: setup.caseId, body: "The carrier delayed the parcel.", locale: "en-CA" });
  if (!a.ok || !b.ok) throw new Error("setup: submitPosition failed");
  return setup;
}

async function status(outcome: Awaited<ReturnType<typeof authorDraft>>) {
  const response = mutationFailureResponse(outcome);
  return response ? response.status : 200;
}

describe("author_draft: refusals leave the case untouched", () => {
  it("refuses parties, an admin and an unassigned manager", async () => {
    const { caseId } = await caseAtPositions();
    const { evidenceIds } = await prisma.case.findUniqueOrThrow({ where: { id: caseId }, include: { evidenceItems: true } }).then(c => ({ evidenceIds: c.evidenceItems.map(e => e.id) }));
    const fields = validFields([{ evidence_item_id: evidenceIds[0], relevance: "Relevant." }]);
    expect(await status(await authorDraft({ actorId: complainantId, actorRole: "COMPLAINANT", caseId, fields }))).toBe(403);
    expect(await status(await authorDraft({ actorId: respondentId, actorRole: "RESPONDENT", caseId, fields }))).toBe(403);
    expect(await status(await authorDraft({ actorId: adminId, actorRole: "ADMIN", caseId, fields }))).toBe(403);
    expect(await status(await authorDraft({ actorId: otherManagerId, actorRole: "CASE_MANAGER", caseId, fields }))).toBe(404);
    const row = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
    expect(row.state).toBe("POSITIONS");
    expect(await prisma.recommendation.count({ where: { caseId } })).toBe(0);
  });

  it("refuses before positions are complete", async () => {
    const { caseId, evidenceIds } = await caseAtIntake();
    const outcome = await authorDraft({ actorId: managerId, actorRole: "CASE_MANAGER", caseId, fields: validFields([{ evidence_item_id: evidenceIds[0], relevance: "Relevant." }]) });
    expect(outcome.ok).toBe(false);
    expect(await status(outcome)).toBe(409);
    expect(await prisma.recommendation.count({ where: { caseId } })).toBe(0);
  });

  it("refuses incomplete, overclaiming or mis-cited drafts", async () => {
    const { caseId } = await caseAtPositions();
    const { evidenceIds: foreign } = await caseAtIntake();
    const own = (await prisma.evidenceItem.findMany({ where: { caseId }, select: { id: true } })).map(e => e.id);
    const cite = [{ evidence_item_id: own[0], relevance: "Relevant." }];
    const attempts: unknown[] = [
      validFields([]),
      { ...validFields(cite), limits: [] },
      { ...validFields(cite), not_considered: [] },
      { ...validFields(cite), reasoning: "This decision is final." },
      validFields([{ evidence_item_id: foreign[0], relevance: "From another case." }]),
      validFields([...cite, ...cite]),
      { ...validFields(cite), evidence_citations: [{ ...cite[0], verified: true }] },
      { ...validFields(cite), model: { id: "claude", prompt_version: "x" } },
      { ...validFields(cite), reviewer: { user_id: managerId, issued_at: new Date().toISOString() } },
      { ...validFields(cite), knowledge_sources: [] },
      { ...validFields(cite), conflict_knowledge: {} },
      null,
    ];
    for (const fields of attempts) {
      const outcome = await authorDraft({ actorId: managerId, actorRole: "CASE_MANAGER", caseId, fields });
      expect(outcome.ok, JSON.stringify(fields)).toBe(false);
      expect(await status(outcome)).toBe(409);
    }
    expect((await prisma.case.findUniqueOrThrow({ where: { id: caseId } })).state).toBe("POSITIONS");
    expect(await prisma.recommendation.count({ where: { caseId } })).toBe(0);
  });
});

describe("author_draft: the full synthetic journey without a model", () => {
  it("drafts, revises, issues, gains approval and consent, exports and closes", async () => {
    const { caseId, evidenceIds } = await caseAtPositions();
    const citations = [{ evidence_item_id: evidenceIds[0], relevance: "Shows the promised delivery date." }];

    const first = await authorDraft({ actorId: managerId, actorRole: "CASE_MANAGER", caseId, fields: validFields(citations) });
    expect(first.ok).toBe(true);
    const afterFirst = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
    expect(afterFirst.state).toBe("DRAFTING");
    const v1 = await prisma.recommendation.findUniqueOrThrow({ where: { id: afterFirst.currentRecommendationId! } });
    expect(v1).toMatchObject({ version: 1, status: "DRAFT", modelId: HUMAN_AUTHORED_MODEL_ID, promptVersion: HUMAN_AUTHORED_PROMPT_VERSION });

    // Replacing a draft needs the version the manager saw and a reason.
    const fields2 = { ...validFields(citations), proposed_outcome: "The seller refunds the shipping fee within 14 days." };
    expect(await status(await authorDraft({ actorId: managerId, actorRole: "CASE_MANAGER", caseId, fields: fields2, replacesRecommendationId: v1.id }))).toBe(409);
    expect(await status(await authorDraft({ actorId: managerId, actorRole: "CASE_MANAGER", caseId, fields: fields2, reason: "Add a deadline." }))).toBe(409);
    const second = await authorDraft({ actorId: managerId, actorRole: "CASE_MANAGER", caseId, fields: fields2, reason: "Add a deadline.", replacesRecommendationId: v1.id });
    expect(second.ok).toBe(true);
    const afterSecond = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
    expect((await prisma.recommendation.findUniqueOrThrow({ where: { id: v1.id } })).status).toBe("SUPERSEDED");
    const v2Id = afterSecond.currentRecommendationId!;
    expect((await prisma.recommendation.findUniqueOrThrow({ where: { id: v2Id } })).version).toBe(2);

    // Issuance stays a separate step for the assigned manager only.
    expect((await issueRecommendation({ actorId: otherManagerId, actorRole: "CASE_MANAGER", caseId })).ok).toBe(false);
    expect((await issueRecommendation({ actorId: complainantId, actorRole: "COMPLAINANT", caseId })).ok).toBe(false);
    const savedResendKey = process.env.RESEND_API_KEY;
    process.env.RESEND_API_KEY = "";
    let issued: Awaited<ReturnType<typeof issueRecommendation>>;
    try {
      issued = await issueRecommendation({ actorId: managerId, actorRole: "CASE_MANAGER", caseId });
    } finally {
      if (savedResendKey === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = savedResendKey;
    }
    expect(issued.ok, issued.ok ? "" : issued.reason).toBe(true);
    const approvalNotices = await prisma.notification.findMany({ where: { caseId, kind: RECOMMENDATION_APPROVAL_REQUIRED_KIND }, select: { userId: true } });
    expect(approvalNotices.map((notice) => notice.userId)).toContain(approverId);
    expect(approvalNotices.map((notice) => notice.userId)).not.toContain(managerId);
    const v2 = await prisma.recommendation.findUniqueOrThrow({ where: { id: v2Id } });
    expect(v2.status).toBe("ISSUED");
    expect(v2.issuedById).toBe(managerId);

    // No new draft once issued; a new version goes through request_new_version.
    expect(await status(await authorDraft({ actorId: managerId, actorRole: "CASE_MANAGER", caseId, fields: validFields(citations), reason: "x", replacesRecommendationId: v2Id }))).toBe(409);

    // Each party sees only their own issued outcome; consent binds to it.
    const outcomeFor = async (partyId: string, body: string) => {
      const issuedOutcome = await issuePartyOutcome({ actorId: managerId, actorRole: "CASE_MANAGER", caseId, partyId, body, locale: "fr-CA" });
      if (!issuedOutcome.ok) throw new Error(issuedOutcome.reason);
      return issuedOutcome.data;
    };
    expect((await issuePartyOutcome({ actorId: complainantId, actorRole: "COMPLAINANT", caseId, partyId: complainantId, body: "self", locale: "fr-CA" })).ok).toBe(false);
    expect((await issuePartyOutcome({ actorId: otherManagerId, actorRole: "CASE_MANAGER", caseId, partyId: complainantId, body: "x", locale: "fr-CA" })).ok).toBe(false);
    const c1 = await outcomeFor(complainantId, "COMPLAINANT-OUTCOME-V1");
    const r1 = await outcomeFor(respondentId, "RESPONDENT-OUTCOME-V1");
    const complainantView = JSON.stringify(await readPartyOutcomes(caseId, { userId: complainantId, globalRole: "COMPLAINANT" }));
    expect(complainantView).toContain("COMPLAINANT-OUTCOME-V1");
    expect(complainantView).not.toContain("RESPONDENT-OUTCOME-V1");
    const respondentView = JSON.stringify(await readPartyOutcomes(caseId, { userId: respondentId, globalRole: "RESPONDENT" }));
    expect(respondentView).not.toContain("COMPLAINANT-OUTCOME-V1");

    const consent = (actorId: string, actorRole: "COMPLAINANT" | "RESPONDENT" | "CASE_MANAGER", outcome: { id: string; version: number }) =>
      giveConsent({ actorId, actorRole, caseId, recommendationId: v2Id, statementVersionId, currentStatementVersionId: statementVersionId, outcomeId: outcome.id, outcomeVersion: outcome.version, authContext: {} });

    // Approval: required, and never by the case's own manager.
    const early = await consent(complainantId, "COMPLAINANT", c1);
    expect(!early.ok && early.code).toBe("APPROVAL_REQUIRED");
    expect((await consent(managerId, "CASE_MANAGER", c1)).ok).toBe(false);
    expect((await consent(complainantId, "COMPLAINANT", r1)).ok).toBe(false);
    expect((await approveResolution({ caseId, actorId: managerId, actorRole: "CASE_MANAGER", rationale: "Self-approval." })).ok).toBe(false);
    expect((await approveResolution({ caseId, actorId: adminId, actorRole: "ADMIN", rationale: "Admin." })).ok).toBe(false);
    expect((await approveResolution({ caseId, actorId: approverId, actorRole: "CASE_MANAGER", rationale: "Reviewed the record and the written reasoning." })).ok).toBe(true);

    // Stale consent: the complainant's consent to v1 stops counting once v2 is issued.
    expect((await consent(complainantId, "COMPLAINANT", c1)).ok).toBe(true);
    const c2 = await outcomeFor(complainantId, "COMPLAINANT-OUTCOME-V2");
    expect(c2.version).toBe(2);
    const revoked = await prisma.consentRecord.findFirstOrThrow({ where: { recommendationId: v2Id, partyId: complainantId } });
    expect(revoked).toMatchObject({ state: "REVOKED", revokedReason: "outcome_reissued" });
    expect((await consent(respondentId, "RESPONDENT", r1)).ok).toBe(true);
    expect((await prisma.case.findUniqueOrThrow({ where: { id: caseId } })).state).toBe("ISSUED");
    expect((await consent(complainantId, "COMPLAINANT", c1)).ok).toBe(false);
    expect((await consent(complainantId, "COMPLAINANT", c2)).ok).toBe(true);
    expect((await prisma.case.findUniqueOrThrow({ where: { id: caseId } })).state).toBe("RESOLVED_CONSENT");

    const record = await buildExportRecord(caseId);
    expect(JSON.stringify(record)).toContain(HUMAN_AUTHORED_MODEL_ID);
    const bundle = await generateExportBundle({ caseId, actorId: managerId });
    const closed = await closeCase({ actorId: managerId, actorRole: "CASE_MANAGER", caseId, exportSha256: bundle.sha256 });
    expect(closed.ok).toBe(true);

    const finalRow = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
    expect(finalRow.state).toBe("CLOSED");
    expect(await verifyCase(prisma, finalRow)).toEqual([]);
    const drafted = await prisma.event.findMany({ where: { caseId, type: "RECOMMENDATION_DRAFTED" }, orderBy: { seq: "asc" } });
    expect(drafted.map(e => (e.payload as { origin?: string }).origin)).toEqual(["case_manager_authored", "case_manager_authored"]);
    expect(await prisma.event.count({ where: { caseId, type: "NOTE_ADDED", payload: { path: ["kind"], equals: "authored_draft_replacement" } } })).toBe(1);
    expect(draftSpy).not.toHaveBeenCalled();
  });
});

describe("issuance re-checks a human-written draft", () => {
  async function draftedCase() {
    const { caseId, evidenceIds } = await caseAtPositions();
    const drafted = await authorDraft({ actorId: managerId, actorRole: "CASE_MANAGER", caseId, fields: validFields([{ evidence_item_id: evidenceIds[0], relevance: "Relevant." }]) });
    if (!drafted.ok) throw new Error(drafted.reason);
    const row = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
    return { caseId, recommendationId: row.currentRecommendationId! };
  }
  async function tamper(recommendationId: string, change: (e: Record<string, unknown>) => Record<string, unknown>, rowData: Record<string, unknown> = {}) {
    const rec = await prisma.recommendation.findUniqueOrThrow({ where: { id: recommendationId } });
    await prisma.recommendation.update({ where: { id: recommendationId }, data: { explanation: change(rec.explanation as Record<string, unknown>) as never, ...rowData } });
  }

  it("refuses a stored draft whose citations were removed", async () => {
    const { caseId, recommendationId } = await draftedCase();
    await tamper(recommendationId, e => ({ ...e, evidence_citations: [] }));
    const issued = await issueRecommendation({ actorId: managerId, actorRole: "CASE_MANAGER", caseId });
    expect(issued.ok).toBe(false);
    expect((await prisma.case.findUniqueOrThrow({ where: { id: caseId } })).state).toBe("DRAFTING");
  });

  it("refuses a draft whose origin markers disagree", async () => {
    const relabelled = await draftedCase();
    await tamper(relabelled.recommendationId, e => ({ ...e, model: { id: "claude-opus-5", prompt_version: "2026-09-22.1" } }));
    expect((await issueRecommendation({ actorId: managerId, actorRole: "CASE_MANAGER", caseId: relabelled.caseId })).ok).toBe(false);

    const rowOnly = await draftedCase();
    await tamper(rowOnly.recommendationId, e => e, { modelId: "claude-opus-5" });
    expect((await issueRecommendation({ actorId: managerId, actorRole: "CASE_MANAGER", caseId: rowOnly.caseId })).ok).toBe(false);
  });

  it("refuses a citation to evidence that is not clean", async () => {
    const { caseId, recommendationId } = await draftedCase();
    const rec = await prisma.recommendation.findUniqueOrThrow({ where: { id: recommendationId } });
    const cited = (rec.explanation as { evidence_citations: Array<{ evidence_item_id: string }> }).evidence_citations[0].evidence_item_id;
    await prisma.evidenceItem.update({ where: { id: cited }, data: { scanStatus: "REJECTED" } });
    expect((await issueRecommendation({ actorId: managerId, actorRole: "CASE_MANAGER", caseId })).ok).toBe(false);
  });
});
