import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import fr from "../../messages/fr-CA.json";
import en from "../../messages/en-CA.json";
import { prisma } from "../../src/lib/prisma";
import { createCase, openIntake, submitCase } from "../../src/domain/mutate";
import { verifyCase } from "../../src/domain/verifyEvents";
import { replayCaseState } from "../../src/domain/replay";
import {
  linkClaimEvidence,
  readClaimGraph,
  recordClaim,
  recordClaimRelationship,
  recordReview,
  recordSource,
  updateClaim,
} from "../../src/domain/claimWrites";
import type { ClaimsCopy } from "../../src/app/[locale]/cases/[caseId]/ClaimsList";
import { renderClaimsPanelHtml } from "../../src/app/[locale]/cases/[caseId]/renderClaimsPanelHtml";

let complainantId: string;
let respondentId: string;
let managerId: string;
let otherManagerId: string;
let adminId: string;
let statementId: string;

beforeAll(async () => {
  const create = (role: "COMPLAINANT" | "RESPONDENT" | "CASE_MANAGER" | "ADMIN", label: string) => prisma.user.create({
    data: { email: `claims-${label}-${randomUUID()}@example.com`, displayName: `Claims ${label}`, globalRole: role },
  });
  const [complainant, respondent, manager, otherManager, admin] = await Promise.all([
    create("COMPLAINANT", "complainant"),
    create("RESPONDENT", "respondent"),
    create("CASE_MANAGER", "manager"),
    create("CASE_MANAGER", "other-manager"),
    create("ADMIN", "admin"),
  ]);
  complainantId = complainant.id;
  respondentId = respondent.id;
  managerId = manager.id;
  otherManagerId = otherManager.id;
  adminId = admin.id;
  statementId = (await prisma.consentStatementVersion.create({
    data: {
      version: Number.parseInt(randomUUID().replaceAll("-", "").slice(0, 8), 16) % 2_000_000_000,
      locale: "fr-CA",
      body: "Synthetic claim provenance consent.",
      effectiveFrom: new Date(),
    },
  })).id;
});

async function assignedCase() {
  const created = await createCase({
    actorId: complainantId,
    actorRole: "COMPLAINANT",
    referenceNumber: `AE-CLAIMS-${randomUUID()}`,
    complainantId,
    respondentId,
    disputeDescription: "The delivery note and the invoice do not describe the same date.",
    simulated: true,
    requestedStatementVersionId: statementId,
    currentStatementVersionId: statementId,
  });
  if (!created.ok) throw new Error(created.reason);
  const caseId = created.data.caseId;
  if (!(await submitCase({ actorId: complainantId, actorRole: "COMPLAINANT", caseId })).ok) throw new Error("submit failed");
  if (!(await openIntake({ actorId: managerId, actorRole: "CASE_MANAGER", caseId, hasConflict: false })).ok) throw new Error("intake failed");
  return caseId;
}

function copyFor(messages: typeof en): ClaimsCopy {
  const claims = messages.workspace.claims;
  return {
    title: claims.title,
    description: claims.description,
    empty: claims.empty,
    needsEvidenceHeading: claims.needsEvidenceHeading,
    needsEvidenceNotice: claims.needsEvidenceNotice,
    why: claims.why,
    provenanceTitle: claims.provenanceTitle,
    excerptLabel: claims.excerptLabel,
    sourceLabel: claims.sourceLabel,
    recordedBy: claims.recordedBy,
    linkRecordedBy: claims.linkRecordedBy,
    redacted: claims.redacted,
    citation: claims.citation,
    framework: claims.framework,
    evidenceItem: claims.evidenceItem,
    confidenceLabel: claims.confidenceLabel,
    statusLabel: claims.statusLabel,
    typeLabel: claims.typeLabel,
    impactNotice: claims.impactNotice,
    relationshipsTitle: claims.relationshipsTitle,
    noRelationships: claims.noRelationships,
    type: claims.type,
    confidence: claims.confidence,
    status: claims.status,
    linkPredicate: claims.linkPredicate,
    relationPredicate: claims.relationPredicate,
  };
}

function renderedClaimIds(html: string): string[] {
  const ids: string[] = [];
  for (const match of html.matchAll(/<li\b([^>]*)>/g)) {
    const attrs = match[1] ?? "";
    if (!attrs.includes('data-claim-rendered="true"')) continue;
    const id = attrs.match(/data-claim-id="([^"]+)"/);
    if (!id?.[1]) throw new Error("A rendered claim is missing data-claim-id.");
    ids.push(id[1]);
  }
  return ids;
}

describe("traceable core writes", () => {
  it("lets only the assigned case manager author, and parties can read provenance", async () => {
    const caseId = await assignedCase();
    const actor = { caseId, actorRole: "CASE_MANAGER" as const, actorId: managerId };
    expect(await recordClaim({ ...actor, actorId: adminId, actorRole: "ADMIN", claimType: "FACTUAL", text: "Admin text", confidence: "ESTABLISHED", locale: "en-CA" })).toMatchObject({ ok: false, step: "authorize-role" });
    expect(await recordClaim({ ...actor, actorId: complainantId, actorRole: "COMPLAINANT", claimType: "FACTUAL", text: "Party text", confidence: "ESTABLISHED", locale: "en-CA" })).toMatchObject({ ok: false, step: "authorize-role" });
    expect(await recordClaim({ ...actor, actorId: otherManagerId, claimType: "FACTUAL", text: "Other manager", confidence: "ESTABLISHED", locale: "en-CA" })).toMatchObject({ ok: false, step: "not-found" });
    expect(await prisma.claim.count({ where: { caseId } })).toBe(0);

    const statute = await recordSource({
      ...actor,
      kind: "STATUTE",
      title: "Civil Code article",
      citation: "C.C.Q. art. 1457",
      legalFramework: "Code civil du Québec",
      language: "fr-CA",
    });
    expect(statute.ok).toBe(true);
    expect(await recordSource({ ...actor, kind: "STATUTE", title: "Missing citation" })).toMatchObject({ ok: false, step: "guard" });

    const evidence = await prisma.evidenceItem.create({
      data: {
        caseId,
        submittedById: complainantId,
        kind: "DOCUMENT",
        title: "Delivery note",
        storageKey: `claims-${randomUUID()}`,
        sha256: "a".repeat(64),
        byteSize: 12,
        mimeType: "text/plain",
        scanStatus: "CLEAN",
        simulated: true,
      },
    });
    const evidenceSource = await recordSource({ ...actor, kind: "EVIDENCE_ITEM", title: "Delivery note source", evidenceItemId: evidence.id });
    expect(evidenceSource.ok).toBe(true);
    if (!statute.ok || !evidenceSource.ok) throw new Error("source setup failed");

    const bare = await recordClaim({
      ...actor,
      claimType: "FACTUAL",
      text: "A bare assertion with no excerpt.",
      confidence: "ESTABLISHED",
      locale: "en-CA",
    });
    const supported = await recordClaim({
      ...actor,
      claimType: "FACTUAL",
      text: "The delivery note and the invoice name different dates.",
      confidence: "PROBABLE",
      confidenceRationale: "One record is still unread.",
      locale: "en-CA",
    });
    const impact = await recordClaim({
      ...actor,
      claimType: "IMPACT_STATEMENT",
      text: "I lost sleep after the unpaid invoice.",
      confidence: "UNKNOWN",
      confidenceRationale: "This is reported experience, not a checked event.",
      locale: "fr-CA",
    });
    expect(bare.ok && supported.ok && impact.ok).toBe(true);
    if (!bare.ok || !supported.ok || !impact.ok) throw new Error("claim setup failed");

    expect(await updateClaim({ ...actor, claimId: bare.data.id, status: "OPEN" })).toMatchObject({ ok: false, step: "guard" });
    expect(await linkClaimEvidence({ ...actor, claimId: supported.data.id, sourceId: evidenceSource.data.id, predicate: "ORIGINATES_FROM", excerpt: "   " })).toMatchObject({ ok: false, step: "guard" });
    const link = await linkClaimEvidence({
      ...actor,
      claimId: supported.data.id,
      sourceId: evidenceSource.data.id,
      predicate: "ORIGINATES_FROM",
      excerpt: "Left at the door on 2 March, invoice says 4 March.",
    });
    const impactLink = await linkClaimEvidence({
      ...actor,
      claimId: impact.data.id,
      sourceId: statute.data.id,
      predicate: "QUALIFIES",
      excerpt: "I have not slept since the invoice went unpaid.",
    });
    expect(link.ok && impactLink.ok).toBe(true);
    expect((await updateClaim({ ...actor, claimId: supported.data.id, status: "OPEN", rationale: "Excerpt now on file." })).ok).toBe(true);

    const relationship = await recordClaimRelationship({
      ...actor,
      fromClaimId: impact.data.id,
      toClaimId: supported.data.id,
      predicate: "ALLEGED_TO_HAVE_CONTRIBUTED_TO",
      evidenceId: statute.data.id,
      rationale: "The experience is tied to the date mismatch, not treated as the date itself.",
    });
    const review = await recordReview({ ...actor, claimId: supported.data.id, action: "NOTED", rationale: "Excerpt checked against the delivery note." });
    const beforeReviews = await prisma.reviewTrail.count({ where: { caseId } });
    expect(await recordReview({ ...actor, claimId: supported.data.id, action: "APPROVED", rationale: "Sign-off is later." })).toMatchObject({ ok: false, step: "guard" });
    expect(await prisma.reviewTrail.count({ where: { caseId } })).toBe(beforeReviews);
    expect(relationship.ok && review.ok).toBe(true);

    const stored = await prisma.claim.findUniqueOrThrow({ where: { id: impact.data.id } });
    expect(stored.doNotSummarizeAsSettled).toBe(true);
    expect(stored.claimType).toBe("IMPACT_STATEMENT");

    const partyView = await readClaimGraph(caseId, { userId: complainantId, globalRole: "COMPLAINANT" });
    expect(partyView?.canAuthor).toBe(false);
    expect(partyView?.view.rendered.map((item) => item.id).sort()).toEqual([impact.data.id, supported.data.id].sort());
    expect(partyView?.view.needsEvidence.map((item) => item.id)).toEqual([bare.data.id]);
    expect(partyView?.view.needsEvidence[0]?.renderedStatus).toBe("NEEDS_EVIDENCE");
    expect(partyView?.view.rendered.find((item) => item.id === impact.data.id)?.shownAsFactClaim).toBe(false);

    const caseRow = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
    expect(await verifyCase(prisma, caseRow)).toEqual([]);
    const events = await prisma.event.findMany({ where: { caseId }, orderBy: { seq: "asc" } });
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining([
      "SOURCE_RECORDED",
      "CLAIM_RECORDED",
      "CLAIM_EVIDENCE_LINKED",
      "CLAIM_UPDATED",
      "CLAIM_RELATIONSHIP_RECORDED",
      "REVIEW_RECORDED",
    ]));
    expect(replayCaseState(events)).toBe(caseRow.state);
  });

  it("fails when any rendered claim in fr-CA or en-CA lacks a verbatim excerpt row", async () => {
    const caseId = await assignedCase();
    const actor = { caseId, actorRole: "CASE_MANAGER" as const, actorId: managerId };
    const source = await recordSource({ ...actor, kind: "DOCUMENT", title: "Carrier note", origin: "Carrier" });
    const supported = await recordClaim({
      ...actor,
      claimType: "FACTUAL",
      text: "The carrier note names 2 March.",
      confidence: "ESTABLISHED",
      locale: "en-CA",
    });
    const bare = await recordClaim({
      ...actor,
      claimType: "CAUSAL",
      text: "A bare causal assertion with no excerpt.",
      confidence: "DISPUTED",
      confidenceRationale: "No excerpt is linked.",
      locale: "fr-CA",
    });
    if (!source.ok || !supported.ok || !bare.ok) throw new Error("fixture failed");
    const linked = await linkClaimEvidence({
      ...actor,
      claimId: supported.data.id,
      sourceId: source.data.id,
      predicate: "SUPPORTS",
      excerpt: "Parcel left at the door on 2 March.",
    });
    if (!linked.ok) throw new Error("link failed");

    const graph = await readClaimGraph(caseId, { userId: managerId, globalRole: "CASE_MANAGER" });
    if (!graph) throw new Error("graph missing");
    const manager = await prisma.user.findUniqueOrThrow({ where: { id: managerId } });

    for (const [locale, messages] of [["fr-CA", fr], ["en-CA", en]] as const) {
      const html = renderClaimsPanelHtml({ locale, view: graph.view, authors: [{ id: managerId, displayName: manager.displayName }], copy: copyFor(messages) });
      expect(html).toContain(`data-claims-locale="${locale}"`);
      expect(html).toContain(messages.workspace.claims.why);
      const ids = renderedClaimIds(html);
      expect(ids).toContain(supported.data.id);
      expect(ids).not.toContain(bare.data.id);
      expect(html).not.toContain("A bare causal assertion with no excerpt.");
      const rows = await prisma.claimEvidenceLink.findMany({ where: { claimId: { in: ids }, deletedAt: null } });
      for (const id of ids) {
        const excerpts = rows.filter((row) => row.claimId === id).map((row) => row.excerpt.trim()).filter((excerpt) => excerpt.length > 0);
        expect(excerpts.length, `Rendered claim ${id} in ${locale} lacks a claim_evidence_links row with a verbatim excerpt`).toBeGreaterThan(0);
      }
    }
  });
});
