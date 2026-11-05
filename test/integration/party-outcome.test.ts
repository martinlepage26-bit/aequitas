import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildExportRecord, buildPartyExportArchive } from "../../src/domain/exportBundle";
import { visibleCaseEvents } from "../../src/domain/eventTimeline";
import { declineConsent, giveConsent } from "../../src/domain/mutate";
import { issuePartyOutcome, readPartyOutcomes, savePartyOutcomeDraft } from "../../src/domain/partyOutcome";
import { prisma } from "../../src/lib/prisma";

/**
 * The assigned mediator writes one outcome per party. A party reads only
 * their own issued text. Consent and decline stay closed until that text
 * is issued. An approver and an admin can read both, including drafts.
 */

let complainantId: string;
let respondentId: string;
let managerId: string;
let approverId: string;
let adminId: string;
let outsiderId: string;
let statementVersionId: string;

beforeAll(async () => {
  const mk = (label: string, globalRole: "COMPLAINANT" | "RESPONDENT" | "CASE_MANAGER" | "ADMIN", isApprover = false) =>
    prisma.user.create({ data: { email: `outcome-${label}-${randomUUID()}@example.com`, displayName: `Outcome ${label}`, globalRole, isApprover } });
  const [complainant, respondent, manager, approver, admin, outsider, statement] = await Promise.all([
    mk("complainant", "COMPLAINANT"),
    mk("respondent", "RESPONDENT"),
    mk("manager", "CASE_MANAGER"),
    mk("approver", "CASE_MANAGER", true),
    mk("admin", "ADMIN"),
    mk("outsider", "CASE_MANAGER"),
    prisma.consentStatementVersion.create({
      data: { version: Number.parseInt(randomUUID().replaceAll("-", "").slice(0, 8), 16) % 2_000_000_000, locale: "fr-CA", body: "Test.", effectiveFrom: new Date() },
    }),
  ]);
  complainantId = complainant.id;
  respondentId = respondent.id;
  managerId = manager.id;
  approverId = approver.id;
  adminId = admin.id;
  outsiderId = outsider.id;
  statementVersionId = statement.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function seedIssuedCase() {
  const caseRow = await prisma.case.create({
    data: {
      referenceNumber: `AE-OUTCOME-${randomUUID().slice(0, 8)}`,
      state: "ISSUED",
      simulated: true,
      consentOnlyResolution: true,
      disputeDescription: "Party outcome test dispute.",
      complainantId,
      respondentId,
      caseManagerId: managerId,
    },
  });
  const recommendation = await prisma.recommendation.create({
      data: {
        caseId: caseRow.id,
        version: 1,
        status: "ISSUED",
        explanation: { summary: "s", proposed_outcome: "p", reasoning: "r", evidence_citations: [], limits: [], not_considered: [] },
        modelId: "test",
        promptVersion: "test",
        issuedById: managerId,
        issuedAt: new Date(),
      },
  });
  await prisma.case.update({ where: { id: caseRow.id }, data: { currentRecommendationId: recommendation.id } });
  return { caseId: caseRow.id, recommendationId: recommendation.id };
}

async function consent(
  caseId: string,
  recommendationId: string,
  actorId: string,
  actorRole: "COMPLAINANT" | "RESPONDENT",
  decline = false,
  shown?: { id: string; version: number },
) {
  const outcome = shown ?? await prisma.partyOutcome.findFirst({
    where: { caseId, partyId: actorId, status: "ISSUED" },
    orderBy: { version: "desc" },
    select: { id: true, version: true },
  });
  const input = {
    actorId,
    actorRole,
    caseId,
    recommendationId,
    statementVersionId,
    currentStatementVersionId: statementVersionId,
    outcomeId: outcome?.id ?? "not-issued",
    outcomeVersion: outcome?.version ?? 0,
    authContext: {},
  };
  return decline ? declineConsent(input) : giveConsent(input);
}

function zipJson(buffer: Buffer): {
  partyOutcomes: { partyId: string; status: string; body: string; citations?: { evidenceItemId: string; relevance?: string }[] }[];
  timeline: { type: string; payload: { partyId?: string; outcomeId?: string; reason?: string } }[];
  consent: { partyId: string; state: string; revokedAt: string | null; partyOutcomeId: string | null; partyOutcomeVersion: number | null }[];
} {
  const file = `/tmp/party-outcome-${randomUUID()}.zip`;
  writeFileSync(file, buffer);
  try {
    const raw = execFileSync("python3", ["-c", "import sys, zipfile; z=zipfile.ZipFile(sys.argv[1]); sys.stdout.buffer.write(z.read('case-record.json'))", file]);
    return JSON.parse(raw.toString("utf8"));
  } finally {
    unlinkSync(file);
  }
}

describe("party-facing outcomes", () => {
  it("hides a draft and the other party's issued text, and lets staff read both", async () => {
    const { caseId } = await seedIssuedCase();
    const draft = await savePartyOutcomeDraft({
      actorId: managerId, actorRole: "CASE_MANAGER", caseId, partyId: complainantId, body: "COMPLAINANT-DRAFT-only", locale: "fr-CA",
    });
    expect(draft.ok && draft.data.status).toBe("DRAFT");
    const issued = await issuePartyOutcome({
      actorId: managerId, actorRole: "CASE_MANAGER", caseId, partyId: respondentId, body: "RESPONDENT-ISSUED-only", locale: "en-CA",
    });
    expect(issued.ok && issued.data.status).toBe("ISSUED");

    const complainant = await readPartyOutcomes(caseId, { userId: complainantId, globalRole: "COMPLAINANT" });
    expect(complainant?.parties).toHaveLength(1);
    expect(complainant?.parties[0]?.issued).toBeNull();
    expect(complainant?.parties[0]?.draft).toBeNull();
    expect(JSON.stringify(complainant)).not.toContain("COMPLAINANT-DRAFT-only");
    expect(JSON.stringify(complainant)).not.toContain("RESPONDENT-ISSUED-only");

    const respondent = await readPartyOutcomes(caseId, { userId: respondentId, globalRole: "RESPONDENT" });
    expect(respondent?.parties.map((party) => party.issued?.body)).toEqual(["RESPONDENT-ISSUED-only"]);
    expect(JSON.stringify(respondent)).not.toContain("COMPLAINANT-DRAFT-only");

    for (const viewer of [
      { userId: managerId, globalRole: "CASE_MANAGER" as const, isApprover: false },
      { userId: approverId, globalRole: "CASE_MANAGER" as const, isApprover: true },
      { userId: adminId, globalRole: "ADMIN" as const, isApprover: false },
    ]) {
      const staff = await readPartyOutcomes(caseId, viewer);
      const bodies = JSON.stringify(staff);
      expect(bodies).toContain("COMPLAINANT-DRAFT-only");
      expect(bodies).toContain("RESPONDENT-ISSUED-only");
      expect(staff?.canWrite).toBe(viewer.userId === managerId);
    }

    expect(await readPartyOutcomes(caseId, { userId: outsiderId, globalRole: "CASE_MANAGER" })).toBeNull();
    const denied = await savePartyOutcomeDraft({
      actorId: approverId, actorRole: "CASE_MANAGER", caseId, partyId: complainantId, body: "Approver must not write.", locale: "fr-CA",
    });
    expect(!denied.ok && denied.step).toBe("authorize-role");
  });

  it("gates consent and decline on that party's issued outcome, then versions an edit", async () => {
    const { caseId, recommendationId } = await seedIssuedCase();
    const blocked = await consent(caseId, recommendationId, complainantId, "COMPLAINANT");
    expect(!blocked.ok && blocked.code).toBe("OUTCOME_NOT_ISSUED");
    expect(!blocked.ok && blocked.reason).toBe("Outcome not yet available to you");
    const declined = await consent(caseId, recommendationId, respondentId, "RESPONDENT", true);
    expect(!declined.ok && declined.code).toBe("OUTCOME_NOT_ISSUED");
    expect(await prisma.consentRecord.count({ where: { caseId } })).toBe(0);

    const first = await issuePartyOutcome({
      actorId: managerId, actorRole: "CASE_MANAGER", caseId, partyId: complainantId, body: "COMPLAINANT-V1", locale: "fr-CA",
    });
    expect(first.ok).toBe(true);
    expect((await consent(caseId, recommendationId, complainantId, "COMPLAINANT")).ok).toBe(true);
    expect((await consent(caseId, recommendationId, respondentId, "RESPONDENT")).ok).toBe(false);

    const edited = await savePartyOutcomeDraft({
      actorId: managerId, actorRole: "CASE_MANAGER", caseId, partyId: complainantId, body: "COMPLAINANT-V2-DRAFT", locale: "fr-CA",
    });
    expect(edited.ok && edited.data.version).toBe(2);
    const duringEdit = await readPartyOutcomes(caseId, { userId: complainantId, globalRole: "COMPLAINANT" });
    expect(duringEdit?.parties[0]?.issued?.body).toBe("COMPLAINANT-V1");
    expect(JSON.stringify(duringEdit)).not.toContain("COMPLAINANT-V2-DRAFT");

    const reissued = await issuePartyOutcome({
      actorId: managerId, actorRole: "CASE_MANAGER", caseId, partyId: complainantId, body: "COMPLAINANT-V2", locale: "fr-CA",
    });
    expect(reissued.ok && reissued.data.version).toBe(2);
    const after = await readPartyOutcomes(caseId, { userId: complainantId, globalRole: "COMPLAINANT" });
    expect(after?.parties[0]?.issued?.body).toBe("COMPLAINANT-V2");

    const events = await prisma.event.findMany({ where: { caseId }, orderBy: { seq: "asc" } });
    expect(events.map((event) => event.type)).toEqual([
      "PARTY_OUTCOME_EDITED",
      "PARTY_OUTCOME_ISSUED",
      "CONSENT_GIVEN",
      "PARTY_OUTCOME_EDITED",
      "PARTY_OUTCOME_EDITED",
      "PARTY_OUTCOME_ISSUED",
      "CONSENT_REVOKED",
    ]);
    expect(events.every((event) => !JSON.stringify(event.payload).includes("COMPLAINANT-V"))).toBe(true);
    const respondentFeed = visibleCaseEvents(events, { globalRole: "RESPONDENT", userId: respondentId, access: "party" });
    expect(respondentFeed.some((event) => event.type.startsWith("PARTY_OUTCOME_"))).toBe(false);
    expect(respondentFeed.map((event) => event.type)).not.toContain("CONSENT_REVOKED");
    expect(JSON.stringify(respondentFeed)).not.toContain("outcome_reissued");
    const complainantFeed = visibleCaseEvents(events, { globalRole: "COMPLAINANT", userId: complainantId, access: "party" });
    expect(complainantFeed.map((event) => event.type)).toEqual(["PARTY_OUTCOME_ISSUED", "CONSENT_GIVEN", "PARTY_OUTCOME_ISSUED", "CONSENT_REVOKED"]);
  });

  it("does not let a consent on version 1 resolve the case after that outcome is re-issued", async () => {
    const { caseId, recommendationId } = await seedIssuedCase();
    const complainantV1 = await issuePartyOutcome({
      actorId: managerId, actorRole: "CASE_MANAGER", caseId, partyId: complainantId, body: "COMPLAINANT-V1", locale: "fr-CA",
    });
    const respondentV1 = await issuePartyOutcome({
      actorId: managerId, actorRole: "CASE_MANAGER", caseId, partyId: respondentId, body: "RESPONDENT-V1", locale: "en-CA",
    });
    expect(complainantV1.ok && respondentV1.ok).toBe(true);
    if (!complainantV1.ok || !respondentV1.ok) return;

    const firstConsent = await consent(caseId, recommendationId, complainantId, "COMPLAINANT");
    expect(firstConsent.ok && firstConsent.data.toState).toBe("ISSUED");
    const bound = await prisma.consentRecord.findFirstOrThrow({ where: { caseId, partyId: complainantId } });
    expect(bound.partyOutcomeId).toBe(complainantV1.data.id);
    expect(bound.partyOutcomeVersion).toBe(complainantV1.data.version);

    const complainantV2 = await issuePartyOutcome({
      actorId: managerId, actorRole: "CASE_MANAGER", caseId, partyId: complainantId, body: "COMPLAINANT-V2", locale: "fr-CA",
    });
    expect(complainantV2.ok && complainantV2.data.version).toBe(2);
    if (!complainantV2.ok) return;
    const revoked = await prisma.consentRecord.findFirstOrThrow({ where: { caseId, partyId: complainantId } });
    expect(revoked.state).toBe("REVOKED");
    expect(revoked.revokedReason).toBe("outcome_reissued");
    expect(revoked.partyOutcomeId).toBe(complainantV1.data.id);
    const notice = await prisma.notification.findFirst({ where: { caseId, userId: complainantId, kind: "outcome_needs_answer" } });
    expect(notice?.locale).toBe("fr-CA");
    expect(await prisma.notification.count({ where: { caseId, userId: respondentId, kind: "outcome_needs_answer" } })).toBe(0);

    const respondentConsent = await consent(caseId, recommendationId, respondentId, "RESPONDENT");
    expect(respondentConsent.ok && respondentConsent.data.toState).toBe("ISSUED");
    expect((await prisma.case.findUniqueOrThrow({ where: { id: caseId } })).state).toBe("ISSUED");

    const again = await consent(caseId, recommendationId, complainantId, "COMPLAINANT");
    expect(again.ok && again.data.toState).toBe("RESOLVED_CONSENT");
    const rebound = await prisma.consentRecord.findFirstOrThrow({ where: { caseId, partyId: complainantId } });
    expect(rebound.state).toBe("GIVEN");
    expect(rebound.partyOutcomeId).toBe(complainantV2.data.id);
    expect(rebound.partyOutcomeVersion).toBe(2);
    expect((await prisma.case.findUniqueOrThrow({ where: { id: caseId } })).state).toBe("RESOLVED_CONSENT");

    const types = (await prisma.event.findMany({ where: { caseId }, orderBy: { seq: "asc" } })).map((event) => event.type);
    expect(types).toContain("CONSENT_REVOKED");
    expect(types.at(-1)).toBe("CASE_RESOLVED");
  });

  it("drops a consent-resolved case when one party's outcome is re-issued", async () => {
    const { caseId, recommendationId } = await seedIssuedCase();
    await issuePartyOutcome({ actorId: managerId, actorRole: "CASE_MANAGER", caseId, partyId: complainantId, body: "COMPLAINANT-V1", locale: "fr-CA" });
    await issuePartyOutcome({ actorId: managerId, actorRole: "CASE_MANAGER", caseId, partyId: respondentId, body: "RESPONDENT-V1", locale: "en-CA" });
    expect((await consent(caseId, recommendationId, complainantId, "COMPLAINANT")).ok).toBe(true);
    expect((await consent(caseId, recommendationId, respondentId, "RESPONDENT")).ok && (await prisma.case.findUniqueOrThrow({ where: { id: caseId } })).state).toBe("RESOLVED_CONSENT");

    const reissued = await issuePartyOutcome({
      actorId: managerId, actorRole: "CASE_MANAGER", caseId, partyId: complainantId, body: "COMPLAINANT-V2", locale: "fr-CA",
    });
    expect(reissued.ok).toBe(true);
    expect((await prisma.case.findUniqueOrThrow({ where: { id: caseId } })).state).toBe("ISSUED");
    expect((await prisma.consentRecord.findFirstOrThrow({ where: { caseId, partyId: complainantId } })).state).toBe("REVOKED");
    expect((await prisma.consentRecord.findFirstOrThrow({ where: { caseId, partyId: respondentId } })).state).toBe("GIVEN");
    const events = await prisma.event.findMany({ where: { caseId, type: "CASE_REOPENED" } });
    expect(events).toHaveLength(1);
  });

  it("revokes a decline when that party's outcome is re-issued, then accepts a decline of the new version", async () => {
    const { caseId, recommendationId } = await seedIssuedCase();
    const first = await issuePartyOutcome({
      actorId: managerId, actorRole: "CASE_MANAGER", caseId, partyId: complainantId, body: "COMPLAINANT-DECLINE-V1", locale: "fr-CA",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect((await consent(caseId, recommendationId, complainantId, "COMPLAINANT", true)).ok).toBe(true);
    expect((await prisma.case.findUniqueOrThrow({ where: { id: caseId } })).state).toBe("RESOLVED_DECLINED");

    const second = await issuePartyOutcome({
      actorId: managerId, actorRole: "CASE_MANAGER", caseId, partyId: complainantId, body: "COMPLAINANT-DECLINE-V2", locale: "en-CA",
    });
    expect(second.ok && second.data.version).toBe(2);
    if (!second.ok) return;
    expect((await prisma.case.findUniqueOrThrow({ where: { id: caseId } })).state).toBe("ISSUED");
    const revoked = await prisma.consentRecord.findFirstOrThrow({ where: { caseId, partyId: complainantId } });
    expect(revoked.state).toBe("REVOKED");
    expect(revoked.revokedReason).toBe("outcome_reissued");
    expect(revoked.partyOutcomeId).toBe(first.data.id);
    expect((await prisma.notification.findFirst({ where: { caseId, userId: complainantId, kind: "outcome_needs_answer" } }))?.locale).toBe("fr-CA");

    expect((await consent(caseId, recommendationId, complainantId, "COMPLAINANT", true)).ok).toBe(true);
    const rebound = await prisma.consentRecord.findFirstOrThrow({ where: { caseId, partyId: complainantId } });
    expect(rebound.state).toBe("DECLINED");
    expect(rebound.partyOutcomeId).toBe(second.data.id);
    expect(rebound.partyOutcomeVersion).toBe(2);
    expect(rebound.revokedReason).toBeNull();
    expect((await prisma.case.findUniqueOrThrow({ where: { id: caseId } })).state).toBe("RESOLVED_DECLINED");
  });

  it("rejects a consent submitted for an outcome the page no longer shows", async () => {
    const { caseId, recommendationId } = await seedIssuedCase();
    const shown = await issuePartyOutcome({
      actorId: managerId, actorRole: "CASE_MANAGER", caseId, partyId: complainantId, body: "COMPLAINANT-STALE-V1", locale: "fr-CA",
    });
    expect(shown.ok).toBe(true);
    if (!shown.ok) return;
    const reissued = await issuePartyOutcome({
      actorId: managerId, actorRole: "CASE_MANAGER", caseId, partyId: complainantId, body: "COMPLAINANT-STALE-V2", locale: "fr-CA",
    });
    expect(reissued.ok && reissued.data.version).toBe(2);

    const stale = await consent(caseId, recommendationId, complainantId, "COMPLAINANT", false, shown.data);
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.code).toBe("OUTCOME_SUPERSEDED");
    expect(stale.reason).toBe("A new outcome was issued, please review it.");
    expect(await prisma.consentRecord.count({ where: { caseId, partyId: complainantId, state: "GIVEN" } })).toBe(0);
    expect((await prisma.case.findUniqueOrThrow({ where: { id: caseId } })).state).toBe("ISSUED");
  });

  it("does not resolve when a re-issue lands between the page view and the consent", async () => {
    const { caseId, recommendationId } = await seedIssuedCase();
    const complainantV1 = await issuePartyOutcome({
      actorId: managerId, actorRole: "CASE_MANAGER", caseId, partyId: complainantId, body: "COMPLAINANT-RACE-V1", locale: "fr-CA",
    });
    const respondentV1 = await issuePartyOutcome({
      actorId: managerId, actorRole: "CASE_MANAGER", caseId, partyId: respondentId, body: "RESPONDENT-RACE-V1", locale: "en-CA",
    });
    expect(complainantV1.ok && respondentV1.ok).toBe(true);
    if (!complainantV1.ok || !respondentV1.ok) return;
    const viewed = { id: complainantV1.data.id, version: complainantV1.data.version };

    expect((await consent(caseId, recommendationId, respondentId, "RESPONDENT", false, respondentV1.data)).ok).toBe(true);
    const reissued = await issuePartyOutcome({
      actorId: managerId, actorRole: "CASE_MANAGER", caseId, partyId: complainantId, body: "COMPLAINANT-RACE-V2", locale: "fr-CA",
    });
    expect(reissued.ok && reissued.data.id !== viewed.id).toBe(true);

    const raced = await consent(caseId, recommendationId, complainantId, "COMPLAINANT", false, viewed);
    expect(raced.ok).toBe(false);
    if (raced.ok) return;
    expect(raced.code).toBe("OUTCOME_SUPERSEDED");
    expect((await prisma.case.findUniqueOrThrow({ where: { id: caseId } })).state).toBe("ISSUED");
    expect(await prisma.consentRecord.count({ where: { caseId, partyId: complainantId, state: "GIVEN" } })).toBe(0);
    expect(await prisma.event.count({ where: { caseId, type: "CASE_RESOLVED" } })).toBe(0);
  });

  it("logs one consent event when the same party submits the displayed outcome twice at once", async () => {
    const { caseId, recommendationId } = await seedIssuedCase();
    const shown = await issuePartyOutcome({
      actorId: managerId, actorRole: "CASE_MANAGER", caseId, partyId: complainantId, body: "COMPLAINANT-ONCE", locale: "fr-CA",
    });
    expect(shown.ok).toBe(true);
    if (!shown.ok) return;
    const [first, second] = await Promise.all([
      consent(caseId, recommendationId, complainantId, "COMPLAINANT", false, shown.data),
      consent(caseId, recommendationId, complainantId, "COMPLAINANT", false, shown.data),
    ]);
    expect(first.ok && second.ok).toBe(true);
    expect(await prisma.event.count({ where: { caseId, type: "CONSENT_GIVEN" } })).toBe(1);
    expect(await prisma.consentRecord.count({ where: { caseId, partyId: complainantId } })).toBe(1);
  });

  it("keeps a re-issued outcome's revocation out of the other party's activity and export", async () => {
    const { caseId, recommendationId } = await seedIssuedCase();
    const complainantV1 = await issuePartyOutcome({
      actorId: managerId, actorRole: "CASE_MANAGER", caseId, partyId: complainantId, body: "COMPLAINANT-PRIVATE-V1", locale: "fr-CA",
    });
    await issuePartyOutcome({
      actorId: managerId, actorRole: "CASE_MANAGER", caseId, partyId: respondentId, body: "RESPONDENT-PRIVATE-V1", locale: "en-CA",
    });
    expect(complainantV1.ok).toBe(true);
    if (!complainantV1.ok) return;
    expect((await consent(caseId, recommendationId, complainantId, "COMPLAINANT", false, complainantV1.data)).ok).toBe(true);
    const reissued = await issuePartyOutcome({
      actorId: managerId, actorRole: "CASE_MANAGER", caseId, partyId: complainantId, body: "COMPLAINANT-PRIVATE-V2", locale: "fr-CA",
    });
    expect(reissued.ok).toBe(true);

    const events = await prisma.event.findMany({ where: { caseId }, orderBy: { seq: "asc" } });
    const respondentFeed = visibleCaseEvents(events, { globalRole: "RESPONDENT", userId: respondentId, access: "party" });
    const complainantFeed = visibleCaseEvents(events, { globalRole: "COMPLAINANT", userId: complainantId, access: "party" });
    const mediatorFeed = visibleCaseEvents(events, { globalRole: "CASE_MANAGER", userId: managerId, access: "assigned-manager" });
    expect(respondentFeed.some((event) => event.type === "CONSENT_REVOKED" || event.type === "CASE_REOPENED")).toBe(false);
    expect(JSON.stringify(respondentFeed.filter((event) => event.type === "CONSENT_GIVEN"))).not.toContain(complainantV1.data.id);
    expect(JSON.stringify(respondentFeed)).not.toContain("outcome_reissued");
    expect(JSON.stringify(complainantFeed.filter((event) => event.type === "CONSENT_REVOKED"))).toContain(complainantV1.data.id);
    expect(JSON.stringify(mediatorFeed.filter((event) => event.type === "CONSENT_REVOKED"))).toContain("outcome_reissued");

    const respondentArchive = zipJson(await buildPartyExportArchive(caseId, respondentId));
    expect(respondentArchive.timeline.some((event) => event.type === "CONSENT_REVOKED" || event.type === "CASE_REOPENED")).toBe(false);
    expect(respondentArchive.timeline.some((event) => event.payload.reason === "outcome_reissued")).toBe(false);
    const otherConsent = respondentArchive.consent.find((entry) => entry.partyId === complainantId);
    expect(otherConsent?.partyOutcomeId).toBeNull();
    expect(otherConsent?.partyOutcomeVersion).toBeNull();
    expect(otherConsent?.state).toBe("NOT_GIVEN");
    expect(otherConsent?.revokedAt).toBeNull();
    expect(respondentArchive.timeline.find((event) => event.type === "CONSENT_GIVEN")?.payload.outcomeId).toBeUndefined();

    const complainantArchive = zipJson(await buildPartyExportArchive(caseId, complainantId));
    expect(complainantArchive.timeline.some((event) => event.type === "CONSENT_REVOKED" && event.payload.outcomeId === complainantV1.data.id)).toBe(true);
    expect(JSON.stringify(complainantArchive)).toContain("outcome_reissued");

    const sealed = await buildExportRecord(caseId);
    expect(sealed.record.timeline.some((event) => event.type === "CONSENT_REVOKED")).toBe(true);
  });

  it("shows the other party a neutral reopened case and notifies them without the outcome", async () => {
    const { caseId, recommendationId } = await seedIssuedCase();
    const complainantV1 = await issuePartyOutcome({
      actorId: managerId, actorRole: "CASE_MANAGER", caseId, partyId: complainantId, body: "COMPLAINANT-REOPEN-V1", locale: "fr-CA",
    });
    const respondentV1 = await issuePartyOutcome({
      actorId: managerId, actorRole: "CASE_MANAGER", caseId, partyId: respondentId, body: "RESPONDENT-REOPEN-V1", locale: "en-CA",
    });
    expect(complainantV1.ok && respondentV1.ok).toBe(true);
    if (!complainantV1.ok || !respondentV1.ok) return;
    expect((await consent(caseId, recommendationId, complainantId, "COMPLAINANT", false, complainantV1.data)).ok).toBe(true);
    expect((await consent(caseId, recommendationId, respondentId, "RESPONDENT", false, respondentV1.data)).ok).toBe(true);
    expect((await prisma.case.findUniqueOrThrow({ where: { id: caseId } })).state).toBe("RESOLVED_CONSENT");

    const reissued = await issuePartyOutcome({
      actorId: managerId, actorRole: "CASE_MANAGER", caseId, partyId: complainantId, body: "COMPLAINANT-REOPEN-V2", locale: "fr-CA",
    });
    expect(reissued.ok).toBe(true);
    expect((await prisma.case.findUniqueOrThrow({ where: { id: caseId } })).state).toBe("ISSUED");

    const events = await prisma.event.findMany({ where: { caseId }, orderBy: { seq: "asc" } });
    const storedReopen = events.find((event) => event.type === "CASE_REOPENED");
    expect(JSON.stringify(storedReopen?.payload)).toContain("outcome_reissued");
    const respondentFeed = visibleCaseEvents(events, { globalRole: "RESPONDENT", userId: respondentId, access: "party" });
    const reopened = respondentFeed.filter((event) => event.type === "CASE_REOPENED");
    expect(reopened).toHaveLength(1);
    expect(reopened[0]?.payload).toEqual({});
    expect(JSON.stringify(respondentFeed)).not.toContain(complainantV1.data.id);
    expect(JSON.stringify(respondentFeed)).not.toContain("outcome_reissued");
    expect(JSON.stringify(respondentFeed)).not.toContain("COMPLAINANT-REOPEN");
    expect(respondentFeed.some((event) => event.type === "CONSENT_REVOKED")).toBe(false);

    const notice = await prisma.notification.findFirst({ where: { caseId, userId: respondentId, kind: "case_reopened" } });
    expect(notice?.locale).toBe("fr-CA");
    expect(await prisma.notification.count({ where: { caseId, userId: complainantId, kind: "case_reopened" } })).toBe(0);
    expect(await prisma.notification.count({ where: { caseId, userId: complainantId, kind: "outcome_needs_answer" } })).toBe(1);

    for (const viewer of [
      { globalRole: "CASE_MANAGER" as const, userId: managerId, access: "assigned-manager" as const },
      { globalRole: "CASE_MANAGER" as const, userId: approverId, access: "approver" as const },
      { globalRole: "ADMIN" as const, userId: adminId, access: "admin" as const },
    ]) {
      const feed = visibleCaseEvents(events, viewer);
      expect(feed.some((event) => event.type === "CONSENT_REVOKED")).toBe(true);
      expect(JSON.stringify(feed.filter((event) => event.type === "CASE_REOPENED"))).toContain("outcome_reissued");
      expect(JSON.stringify(feed)).toContain(complainantV1.data.id);
    }

    const respondentArchive = zipJson(await buildPartyExportArchive(caseId, respondentId));
    const exportedReopen = respondentArchive.timeline.filter((event) => event.type === "CASE_REOPENED");
    expect(exportedReopen).toHaveLength(1);
    expect(exportedReopen[0]?.payload).toEqual({});
    expect(JSON.stringify(respondentArchive)).not.toContain("outcome_reissued");
    expect(JSON.stringify(respondentArchive)).not.toContain(complainantV1.data.id);
    expect(JSON.stringify(respondentArchive)).not.toContain("REVOKED");
    const sealed = await buildExportRecord(caseId);
    expect(JSON.stringify(sealed.record.timeline)).toContain("outcome_reissued");
  });

  it("omits the declining party's outcome id and version from the other party's feed and export", async () => {
    const { caseId, recommendationId } = await seedIssuedCase();
    const shown = await issuePartyOutcome({
      actorId: managerId, actorRole: "CASE_MANAGER", caseId, partyId: complainantId, body: "COMPLAINANT-DECLINE-PRIVATE", locale: "fr-CA",
    });
    expect(shown.ok).toBe(true);
    if (!shown.ok) return;
    expect((await consent(caseId, recommendationId, complainantId, "COMPLAINANT", true, shown.data)).ok).toBe(true);

    const events = await prisma.event.findMany({ where: { caseId }, orderBy: { seq: "asc" } });
    const respondentFeed = visibleCaseEvents(events, { globalRole: "RESPONDENT", userId: respondentId, access: "party" });
    const declinedForRespondent = JSON.stringify(respondentFeed.filter((event) => event.type === "CONSENT_DECLINED"));
    expect(declinedForRespondent).toContain("CONSENT_DECLINED");
    expect(declinedForRespondent).not.toContain(shown.data.id);
    expect(declinedForRespondent).not.toContain("outcomeVersion");
    expect(JSON.stringify(visibleCaseEvents(events, { globalRole: "COMPLAINANT", userId: complainantId, access: "party" }))).toContain(shown.data.id);

    const respondentArchive = zipJson(await buildPartyExportArchive(caseId, respondentId));
    const exported = JSON.stringify(respondentArchive.timeline.filter((event) => event.type === "CONSENT_DECLINED"));
    expect(exported).toContain("CONSENT_DECLINED");
    expect(exported).not.toContain(shown.data.id);
    expect(exported).not.toContain("outcomeVersion");
    const ownArchive = zipJson(await buildPartyExportArchive(caseId, complainantId));
    expect(JSON.stringify(ownArchive.timeline.filter((event) => event.type === "CONSENT_DECLINED"))).toContain(shown.data.id);
  });

  it("puts only that party's issued outcome in their export", async () => {
    const { caseId } = await seedIssuedCase();
    await issuePartyOutcome({ actorId: managerId, actorRole: "CASE_MANAGER", caseId, partyId: complainantId, body: "EXPORT-COMPLAINANT", locale: "fr-CA" });
    await savePartyOutcomeDraft({ actorId: managerId, actorRole: "CASE_MANAGER", caseId, partyId: complainantId, body: "EXPORT-COMPLAINANT-DRAFT", locale: "fr-CA" });
    await issuePartyOutcome({ actorId: managerId, actorRole: "CASE_MANAGER", caseId, partyId: respondentId, body: "EXPORT-RESPONDENT", locale: "fr-CA" });

    const [cOutcome, rOutcome] = await Promise.all([
      prisma.partyOutcome.findFirstOrThrow({ where: { caseId, partyId: complainantId, status: "ISSUED" } }),
      prisma.partyOutcome.findFirstOrThrow({ where: { caseId, partyId: respondentId, status: "ISSUED" } }),
    ]);
    const [cEvidence, rEvidence] = await Promise.all([
      prisma.evidenceItem.create({ data: {
        caseId, submittedById: complainantId, kind: "RECEIPT", title: "Complainant receipt", storageKey: `test/${randomUUID()}`,
        sha256: "a".repeat(64), byteSize: 5, mimeType: "text/plain", scanStatus: "CLEAN", simulated: true,
      } }),
      prisma.evidenceItem.create({ data: {
        caseId, submittedById: respondentId, kind: "RECEIPT", title: "Respondent receipt", storageKey: `test/${randomUUID()}`,
        sha256: "b".repeat(64), byteSize: 5, mimeType: "text/plain", scanStatus: "CLEAN", simulated: true,
      } }),
    ]);
    await prisma.partyOutcomeCitation.createMany({ data: [
      { partyOutcomeId: cOutcome.id, evidenceItemId: cEvidence.id, relevance: "Supports complainant outcome", startChar: 0, endChar: 5, sourceSha256: "a".repeat(64), extractedTextSha256: "a".repeat(64), extractionMethod: "utf8" },
      { partyOutcomeId: rOutcome.id, evidenceItemId: rEvidence.id, relevance: "Supports respondent outcome", startChar: 0, endChar: 5, sourceSha256: "b".repeat(64), extractedTextSha256: "b".repeat(64), extractionMethod: "utf8" },
    ] });

    const sealed = await buildExportRecord(caseId);
    const sealedBodies = sealed.record.partyOutcomes.map((outcome) => outcome.body);
    expect(sealedBodies).toContain("EXPORT-COMPLAINANT");
    expect(sealedBodies).toContain("EXPORT-COMPLAINANT-DRAFT");
    expect(sealedBodies).toContain("EXPORT-RESPONDENT");
    expect(sealed.record.partyOutcomes.find((outcome) => outcome.id === cOutcome.id)?.citations.map((citation) => citation.evidenceItemId)).toEqual([cEvidence.id]);
    expect(sealed.record.partyOutcomes.find((outcome) => outcome.id === rOutcome.id)?.citations.map((citation) => citation.evidenceItemId)).toEqual([rEvidence.id]);

    const archive = zipJson(await buildPartyExportArchive(caseId, complainantId));
    expect(archive.partyOutcomes.map((outcome) => outcome.body)).toEqual(["EXPORT-COMPLAINANT"]);
    expect(archive.partyOutcomes[0].citations?.map((citation) => citation.evidenceItemId)).toEqual([cEvidence.id]);
    expect(archive.partyOutcomes[0].citations?.[0].relevance).toBe("");
    expect(JSON.stringify(archive)).not.toContain("EXPORT-RESPONDENT");
    expect(JSON.stringify(archive)).not.toContain(rEvidence.id);
    expect(JSON.stringify(archive)).not.toContain("EXPORT-COMPLAINANT-DRAFT");
    expect(archive.timeline.filter((event) => event.type === "PARTY_OUTCOME_ISSUED").map((event) => event.payload.partyId)).toEqual([complainantId]);
    expect(archive.timeline.some((event) => event.type === "PARTY_OUTCOME_EDITED")).toBe(false);
  });
});
