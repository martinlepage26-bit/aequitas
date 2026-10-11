import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../src/lib/prisma";
import { appendEvent } from "../../src/domain/events";
import { giveConsent, mutationFailureResponse } from "../../src/domain/mutate";
import {
  approveResolution,
  codedFailureResponse,
  loadResolutionBlockers,
  openContestation,
  overruleContestation,
  readResolutionView,
  respondToContestation,
  withdrawContestation,
} from "../../src/domain/resolution";
import { verifyCase } from "../../src/domain/verifyEvents";

/**
 * Phase 3a/3b acceptance (handoff §10 phase 3): an open contestation blocks
 * resolution with 409 OPEN_CONTESTATION; a new case needs approver sign-off
 * (409 APPROVAL_REQUIRED); the author or owner of the case cannot approve
 * (409 SAME_AUTHOR); an administrator cannot approve (403); an overrule
 * needs a reason; cases from before the migration keep consent-only.
 */

let complainantId: string;
let respondentId: string;
let managerId: string;
let approverId: string;
let otherManagerId: string;
let adminId: string;
let statementVersionId: string;

beforeAll(async () => {
  const mk = (label: string, globalRole: "COMPLAINANT" | "RESPONDENT" | "CASE_MANAGER" | "ADMIN", isApprover = false) =>
    prisma.user.create({ data: { email: `p3-${label}-${randomUUID()}@example.com`, displayName: `P3 ${label}`, globalRole, isApprover } });
  const [c, r, m, a, o, admin, statement] = await Promise.all([
    mk("complainant", "COMPLAINANT"),
    mk("respondent", "RESPONDENT"),
    mk("manager", "CASE_MANAGER", true),
    mk("approver", "CASE_MANAGER", true),
    mk("other-manager", "CASE_MANAGER"),
    mk("admin", "ADMIN"),
    prisma.consentStatementVersion.create({
      data: { version: Number.parseInt(randomUUID().replaceAll("-", "").slice(0, 8), 16) % 2_000_000_000, locale: "fr-CA", body: "Test.", effectiveFrom: new Date() },
    }),
  ]);
  complainantId = c.id;
  respondentId = r.id;
  managerId = m.id;
  approverId = a.id;
  otherManagerId = o.id;
  adminId = admin.id;
  statementVersionId = statement.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** An ISSUED case with an issued recommendation, seeded directly (no ClamAV or storage needed). */
async function seedIssuedCase(opts: { consentOnlyResolution?: boolean } = {}) {
  const caseRow = await prisma.case.create({
    data: {
      referenceNumber: `AE-P3-${randomUUID().slice(0, 8)}`,
      state: "ISSUED",
      simulated: true,
      disputeDescription: "Phase 3 test dispute.",
      complainantId,
      respondentId,
      caseManagerId: managerId,
      ...(opts.consentOnlyResolution === undefined ? {} : { consentOnlyResolution: opts.consentOnlyResolution }),
    },
  });
  const recommendation = await prisma.recommendation.create({
    data: { caseId: caseRow.id, version: 1, status: "ISSUED", explanation: { summary: "s" }, modelId: "test", promptVersion: "test", issuedById: managerId, issuedAt: new Date() },
  });
  await prisma.case.update({ where: { id: caseRow.id }, data: { currentRecommendationId: recommendation.id } });
  await prisma.$transaction((tx) => appendEvent(tx, { caseId: caseRow.id, type: "RECOMMENDATION_ISSUED", actorId: managerId, payload: { recommendationId: recommendation.id } }));
  const claim = await prisma.claim.create({ data: { caseId: caseRow.id, claimType: "FACTUAL", text: "The item arrived broken.", confidence: "PROBABLE", createdById: managerId } });
  return { caseId: caseRow.id, recommendationId: recommendation.id, claimId: claim.id };
}

function consent(caseId: string, recommendationId: string, actorId: string, actorRole: "COMPLAINANT" | "RESPONDENT") {
  return giveConsent({ actorId, actorRole, caseId, recommendationId, statementVersionId, currentStatementVersionId: statementVersionId, authContext: {} });
}

async function statusAndBody(response: Response | null) {
  expect(response).not.toBeNull();
  return { status: response!.status, body: await response!.json() };
}

describe("new cases default to approver sign-off", () => {
  it("a case created after the migration is not consent-only", async () => {
    const { caseId } = await seedIssuedCase();
    const row = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
    expect(row.consentOnlyResolution).toBe(false);
  });
});

describe("resolve (give_consent) returns 409 with a named reason", () => {
  it("APPROVAL_REQUIRED when no approver has signed off", async () => {
    const { caseId, recommendationId } = await seedIssuedCase();
    const outcome = await consent(caseId, recommendationId, complainantId, "COMPLAINANT");
    expect(outcome.ok).toBe(false);
    const { status, body } = await statusAndBody(mutationFailureResponse(outcome as never));
    expect(status).toBe(409);
    expect(body.code).toBe("APPROVAL_REQUIRED");
    expect(await prisma.consentRecord.count({ where: { caseId } })).toBe(0);
  });

  it("OPEN_CONTESTATION while a contestation is open, then resolves after a response", async () => {
    const { caseId, recommendationId, claimId } = await seedIssuedCase();
    const approved = await approveResolution({ caseId, actorId: approverId, actorRole: "CASE_MANAGER", rationale: "Reviewed the record." });
    expect(approved.ok).toBe(true);

    const opened = await openContestation({ caseId, actorId: respondentId, actorRole: "RESPONDENT", targetType: "CLAIM", targetId: claimId, grounds: "The item was intact on delivery." });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(await loadResolutionBlockers(prisma, caseId)).toEqual(["OPEN_CONTESTATION"]);

    const blocked = await consent(caseId, recommendationId, complainantId, "COMPLAINANT");
    const { status, body } = await statusAndBody(mutationFailureResponse(blocked as never));
    expect(status).toBe(409);
    expect(body.code).toBe("OPEN_CONTESTATION");

    const responded = await respondToContestation({ caseId, contestationId: opened.data.id, actorId: managerId, actorRole: "CASE_MANAGER", response: "The delivery photo shows damage." });
    expect(responded.ok).toBe(true);

    expect((await consent(caseId, recommendationId, complainantId, "COMPLAINANT")).ok).toBe(true);
    const second = await consent(caseId, recommendationId, respondentId, "RESPONDENT");
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.data.toState).toBe("RESOLVED_CONSENT");

    const row = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
    expect(await verifyCase(prisma, row)).toEqual([]);
    const types = (await prisma.event.findMany({ where: { caseId }, orderBy: { seq: "asc" } })).map((e) => e.type);
    expect(types).toEqual(["RECOMMENDATION_ISSUED", "RESOLUTION_APPROVED", "CONTESTATION_OPENED", "CONTESTATION_RESPONDED", "CONSENT_GIVEN", "CONSENT_GIVEN", "CASE_RESOLVED"]);
  });

  it("a consent-only (pre-migration) case still resolves through consent alone", async () => {
    const { caseId, recommendationId } = await seedIssuedCase({ consentOnlyResolution: true });
    expect(await loadResolutionBlockers(prisma, caseId)).toEqual([]);
    expect((await consent(caseId, recommendationId, complainantId, "COMPLAINANT")).ok).toBe(true);
    const second = await consent(caseId, recommendationId, respondentId, "RESPONDENT");
    expect(second.ok && second.data.toState).toBe("RESOLVED_CONSENT");
  });

  it("an open contestation also blocks a consent-only case", async () => {
    const { caseId, recommendationId } = await seedIssuedCase({ consentOnlyResolution: true });
    const opened = await openContestation({ caseId, actorId: complainantId, actorRole: "COMPLAINANT", targetType: "RECOMMENDATION", targetId: recommendationId, grounds: "The amount is wrong." });
    expect(opened.ok).toBe(true);
    const blocked = await consent(caseId, recommendationId, respondentId, "RESPONDENT");
    expect(!blocked.ok && blocked.code).toBe("OPEN_CONTESTATION");
    if (!opened.ok) return;
    expect((await withdrawContestation({ caseId, contestationId: opened.data.id, actorId: complainantId, actorRole: "COMPLAINANT" })).ok).toBe(true);
    expect((await consent(caseId, recommendationId, respondentId, "RESPONDENT")).ok).toBe(true);
  });
});

describe("approver sign-off: separation of duties", () => {
  it("the case owner (assigned manager, also the recommendation author) cannot approve: 409 SAME_AUTHOR", async () => {
    const { caseId } = await seedIssuedCase();
    const outcome = await approveResolution({ caseId, actorId: managerId, actorRole: "CASE_MANAGER", rationale: "Self-approval." });
    const { status, body } = await statusAndBody(codedFailureResponse(outcome));
    expect(status).toBe(409);
    expect(body.code).toBe("SAME_AUTHOR");
    expect(await prisma.reviewTrail.count({ where: { caseId, action: "APPROVED" } })).toBe(0);
  });

  it("the author of the latest synthesis cannot approve", async () => {
    const { caseId } = await seedIssuedCase();
    await prisma.synthesisVersion.create({ data: { caseId, version: 1, sections: {}, sentenceMap: {}, diagE: "x", diagP: "x", diagC: "x", createdById: approverId } });
    const outcome = await approveResolution({ caseId, actorId: approverId, actorRole: "CASE_MANAGER", rationale: "Reviewed." });
    expect(!outcome.ok && outcome.code).toBe("SAME_AUTHOR");
  });

  it("an administrator gets 403 ADMIN_CANNOT_APPROVE", async () => {
    const { caseId } = await seedIssuedCase();
    const outcome = await approveResolution({ caseId, actorId: adminId, actorRole: "ADMIN", rationale: "Admin." });
    const { status, body } = await statusAndBody(codedFailureResponse(outcome));
    expect(status).toBe(403);
    expect(body.code).toBe("ADMIN_CANNOT_APPROVE");
  });

  it("a case manager without the approver capability gets 403 NOT_APPROVER; a party gets 403", async () => {
    const { caseId } = await seedIssuedCase();
    const notApprover = await approveResolution({ caseId, actorId: otherManagerId, actorRole: "CASE_MANAGER", rationale: "x" });
    expect((await statusAndBody(codedFailureResponse(notApprover))).status).toBe(403);
    expect(!notApprover.ok && notApprover.code).toBe("NOT_APPROVER");
    const party = await approveResolution({ caseId, actorId: complainantId, actorRole: "COMPLAINANT", rationale: "x" });
    expect(!party.ok && party.code).toBe("PARTY_CANNOT_APPROVE");
  });

  it("requires a rationale, refuses while a contestation is open, and refuses a second sign-off", async () => {
    const { caseId, claimId } = await seedIssuedCase();
    const blank = await approveResolution({ caseId, actorId: approverId, actorRole: "CASE_MANAGER", rationale: "  " });
    expect(!blank.ok && blank.code).toBe("MISSING_RATIONALE");
    const opened = await openContestation({ caseId, actorId: complainantId, actorRole: "COMPLAINANT", targetType: "CLAIM", targetId: claimId, grounds: "Not accurate." });
    expect(opened.ok).toBe(true);
    const whileOpen = await approveResolution({ caseId, actorId: approverId, actorRole: "CASE_MANAGER", rationale: "Reviewed." });
    expect(!whileOpen.ok && whileOpen.code).toBe("OPEN_CONTESTATION");
    if (!opened.ok) return;
    await respondToContestation({ caseId, contestationId: opened.data.id, actorId: managerId, actorRole: "CASE_MANAGER", response: "Answered." });
    const ok = await approveResolution({ caseId, actorId: approverId, actorRole: "CASE_MANAGER", rationale: "Reviewed." });
    expect(ok.ok).toBe(true);
    const review = await prisma.reviewTrail.findFirstOrThrow({ where: { caseId, action: "APPROVED" } });
    expect(review.reviewerId).toBe(approverId);
    expect(review.rationale).toBe("Reviewed.");
    const again = await approveResolution({ caseId, actorId: approverId, actorRole: "CASE_MANAGER", rationale: "Again." });
    expect(!again.ok && again.code).toBe("ALREADY_APPROVED");
  });
});

describe("contestation lifecycle", () => {
  it("an overrule without a reason is rejected; with a reason it records the approver", async () => {
    const { caseId, claimId } = await seedIssuedCase();
    const opened = await openContestation({ caseId, actorId: complainantId, actorRole: "COMPLAINANT", targetType: "CLAIM", targetId: claimId, grounds: "Wrong." });
    if (!opened.ok) throw new Error(opened.reason);
    const noReason = await overruleContestation({ caseId, contestationId: opened.data.id, actorId: approverId, actorRole: "CASE_MANAGER", reason: "" });
    expect(!noReason.ok && noReason.code).toBe("MISSING_RATIONALE");
    const byOwner = await overruleContestation({ caseId, contestationId: opened.data.id, actorId: managerId, actorRole: "CASE_MANAGER", reason: "Mine." });
    expect(!byOwner.ok && byOwner.code).toBe("SAME_AUTHOR");
    const byAdmin = await overruleContestation({ caseId, contestationId: opened.data.id, actorId: adminId, actorRole: "ADMIN", reason: "Admin." });
    expect((await statusAndBody(codedFailureResponse(byAdmin))).status).toBe(403);
    const ok = await overruleContestation({ caseId, contestationId: opened.data.id, actorId: approverId, actorRole: "CASE_MANAGER", reason: "The grounds repeat a point already answered." });
    expect(ok.ok).toBe(true);
    const row = await prisma.contestation.findUniqueOrThrow({ where: { id: opened.data.id } });
    expect(row.status).toBe("OVERRULED");
    expect(row.overruledById).toBe(approverId);
    expect(await prisma.reviewTrail.count({ where: { caseId, action: "OVERRULED_CONTESTATION", reviewerId: approverId } })).toBe(1);
    const closedAgain = await respondToContestation({ caseId, contestationId: opened.data.id, actorId: managerId, actorRole: "CASE_MANAGER", response: "Late." });
    expect(!closedAgain.ok && closedAgain.code).toBe("CONTESTATION_NOT_OPEN");
  });

  it("only parties and the assigned manager open; only the opener withdraws; targets must be on the case", async () => {
    const { caseId, claimId } = await seedIssuedCase();
    const other = await seedIssuedCase();
    const admin = await openContestation({ caseId, actorId: adminId, actorRole: "ADMIN", targetType: "CLAIM", targetId: claimId, grounds: "x" });
    expect(!admin.ok && admin.step).toBe("authorize-role");
    const stranger = await openContestation({ caseId, actorId: otherManagerId, actorRole: "CASE_MANAGER", targetType: "CLAIM", targetId: claimId, grounds: "x" });
    expect(!stranger.ok && stranger.step).toBe("not-found");
    const foreign = await openContestation({ caseId, actorId: complainantId, actorRole: "COMPLAINANT", targetType: "CLAIM", targetId: other.claimId, grounds: "x" });
    expect(!foreign.ok && foreign.code).toBe("TARGET_NOT_ON_CASE");
    const byManager = await openContestation({ caseId, actorId: managerId, actorRole: "CASE_MANAGER", targetType: "CLAIM", targetId: claimId, grounds: "Needs a second look." });
    if (!byManager.ok) throw new Error(byManager.reason);
    const withdrawByOther = await withdrawContestation({ caseId, contestationId: byManager.data.id, actorId: complainantId, actorRole: "COMPLAINANT" });
    expect(withdrawByOther.ok).toBe(false);
    const partyRespond = await respondToContestation({ caseId, contestationId: byManager.data.id, actorId: respondentId, actorRole: "RESPONDENT", response: "x" });
    expect(!partyRespond.ok && partyRespond.step).toBe("authorize-role");
  });

  it("the resolution view reports blockers and what the viewer may do", async () => {
    const { caseId } = await seedIssuedCase();
    const forApprover = await readResolutionView(caseId, { userId: approverId, globalRole: "CASE_MANAGER", isApprover: true });
    expect(forApprover?.blockers).toEqual(["APPROVAL_REQUIRED"]);
    expect(forApprover?.viewer.canApprove).toBe(true);
    const forOwner = await readResolutionView(caseId, { userId: managerId, globalRole: "CASE_MANAGER", isApprover: true });
    expect(forOwner?.viewer.canApprove).toBe(false);
    expect(forOwner?.viewer.approveBlockedCode).toBe("SAME_AUTHOR");
    expect(forOwner?.viewer.canRespond).toBe(true);
    const forParty = await readResolutionView(caseId, { userId: complainantId, globalRole: "COMPLAINANT", isApprover: false });
    expect(forParty?.viewer.canOpen).toBe(true);
    expect(forParty?.viewer.canApprove).toBe(false);
  });
});
