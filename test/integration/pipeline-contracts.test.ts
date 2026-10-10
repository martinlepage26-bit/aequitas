import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../src/lib/prisma";
import { createCase, openIntake, submitCase } from "../../src/domain/mutate";
import { recordSource } from "../../src/domain/claimWrites";
import { verifyCase } from "../../src/domain/verifyEvents";
import { replayCaseState } from "../../src/domain/replay";
import type { TextCompletion } from "../../src/domain/pipeline/provider";
import { assembleSynthesis } from "../../src/domain/pipeline/synthesis";
import {
  acceptClaimProposal,
  acceptContextProposal,
  acknowledgeAssumption,
  assembleAndRecordSynthesis,
  recordAssumption,
  recordSynthesis,
  returnToStage,
  reviseAssumption,
  runClaimDecomposition,
  runContextMapping,
} from "../../src/domain/pipeline/writes";

const previousFlag = process.env.AEQUITAS_PIPELINE_ENABLED;

let complainantId: string;
let respondentId: string;
let managerId: string;
let statementId: string;

beforeAll(async () => {
  process.env.AEQUITAS_PIPELINE_ENABLED = "true";
  const create = (role: "COMPLAINANT" | "RESPONDENT" | "CASE_MANAGER", label: string) => prisma.user.create({
    data: { email: `pipe-${label}-${randomUUID()}@example.com`, displayName: `Pipe ${label}`, globalRole: role },
  });
  const [complainant, respondent, manager] = await Promise.all([
    create("COMPLAINANT", "complainant"),
    create("RESPONDENT", "respondent"),
    create("CASE_MANAGER", "manager"),
  ]);
  complainantId = complainant.id;
  respondentId = respondent.id;
  managerId = manager.id;
  statementId = (await prisma.consentStatementVersion.create({
    data: {
      version: Number.parseInt(randomUUID().replaceAll("-", "").slice(0, 8), 16) % 2_000_000_000,
      locale: "fr-CA",
      body: "Synthetic pipeline consent.",
      effectiveFrom: new Date(),
    },
  })).id;
});

afterAll(() => {
  if (previousFlag === undefined) delete process.env.AEQUITAS_PIPELINE_ENABLED;
  else process.env.AEQUITAS_PIPELINE_ENABLED = previousFlag;
});

function actor(caseId: string) {
  return { caseId, actorId: managerId, actorRole: "CASE_MANAGER" as const };
}

async function assignedCase() {
  const created = await createCase({
    actorId: complainantId,
    actorRole: "COMPLAINANT",
    referenceNumber: `AE-PIPE-${randomUUID()}`,
    complainantId,
    respondentId,
    disputeDescription: "The delivery note and the invoice do not name the same date.",
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

function mockModel(body: string, calls: { n: number }): TextCompletion {
  return {
    provider: "mock",
    model: "mock-free",
    async complete() {
      calls.n += 1;
      return body;
    },
  };
}

async function sourceWithBody(caseId: string, body: string) {
  const recorded = await recordSource({
    ...actor(caseId),
    kind: "DOCUMENT",
    title: "Delivery note",
    body,
    language: "en-CA",
  });
  if (!recorded.ok) throw new Error(recorded.reason);
  return recorded.data.id;
}

describe("phase 2 pipeline contracts", () => {
  it("writes nothing and does not call a model when the flag is off", async () => {
    const caseId = await assignedCase();
    process.env.AEQUITAS_PIPELINE_ENABLED = "false";
    const calls = { n: 0 };
    try {
      const decomposed = await runClaimDecomposition(actor(caseId), mockModel("{}", calls));
      const assumption = await recordAssumption({ ...actor(caseId), text: "The dates may differ.", origin: "CASE_FRAMING" });
      expect(decomposed.ok).toBe(false);
      expect(assumption.ok).toBe(false);
      expect(calls.n).toBe(0);
      expect(await prisma.assumption.count({ where: { caseId } })).toBe(0);
      expect(await prisma.pipelineProposal.count({ where: { caseId } })).toBe(0);
      expect(await prisma.claim.count({ where: { caseId } })).toBe(0);
    } finally {
      process.env.AEQUITAS_PIPELINE_ENABLED = "true";
    }
  });

  it("refuses claim decomposition until a person acknowledges an assumption", async () => {
    const caseId = await assignedCase();
    const body = "Left at the door on 2 March.";
    await sourceWithBody(caseId, body);
    const calls = { n: 0 };
    const blocked = await runClaimDecomposition(actor(caseId), mockModel("{}", calls));
    expect(blocked.ok).toBe(false);
    expect(calls.n).toBe(0);
    const assumption = await recordAssumption({ ...actor(caseId), text: "The two dates may not refer to the same handoff.", origin: "CASE_FRAMING" });
    if (!assumption.ok) throw new Error(assumption.reason);
    const stillBlocked = await runClaimDecomposition(actor(caseId), mockModel("{}", calls));
    expect(stillBlocked.ok).toBe(false);
    expect(calls.n).toBe(0);
  });

  it("keeps a model claim as a proposal until the case manager accepts it", async () => {
    const caseId = await assignedCase();
    const excerpt = "Left at the door on 2 March.";
    const sourceId = await sourceWithBody(caseId, `Note: ${excerpt} The invoice says 4 March.`);
    const assumption = await recordAssumption({ ...actor(caseId), text: "The two dates may not refer to the same handoff.", origin: "CASE_FRAMING" });
    if (!assumption.ok) throw new Error(assumption.reason);
    if (!(await acknowledgeAssumption({ ...actor(caseId), assumptionId: assumption.data.id })).ok) throw new Error("ack failed");
    const calls = { n: 0 };
    const proposed = await runClaimDecomposition(actor(caseId), mockModel(JSON.stringify({
      claims: [{ claim_type: "fact", text: "The parcel was left at the door on 2 March.", excerpt, source_id: sourceId }],
    }), calls));
    if (!proposed.ok) throw new Error(proposed.reason);
    expect(calls.n).toBe(1);
    expect(await prisma.claim.count({ where: { caseId } })).toBe(0);
    expect(await prisma.pipelineProposal.count({ where: { caseId, status: "PROPOSED", kind: "CLAIM" } })).toBe(1);

    const accepted = await acceptClaimProposal({
      ...actor(caseId),
      proposalId: proposed.data.ids[0],
      confidence: "DISPUTED",
      confidenceRationale: "The invoice names a different date and is not yet linked.",
      locale: "en-CA",
    });
    if (!accepted.ok) throw new Error(accepted.reason);
    expect(await prisma.claim.count({ where: { caseId } })).toBe(1);
    const link = await prisma.claimEvidenceLink.findFirst({ where: { claimId: accepted.data.claimId } });
    expect(link?.excerpt).toBe(excerpt);
    expect(await prisma.pipelineProposal.findUnique({ where: { id: proposed.data.ids[0] } })).toMatchObject({ status: "ACCEPTED" });

    const caseRow = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
    expect(caseRow.state).toBe("EVIDENCE_INTAKE");
    expect(await verifyCase(prisma, caseRow)).toEqual([]);
    const events = await prisma.event.findMany({ where: { caseId }, orderBy: { seq: "asc" } });
    expect(replayCaseState(events)).toBe("EVIDENCE_INTAKE");
  });

  it("rejects an excerpt that is not verbatim and an absolute claim from the model", async () => {
    const caseId = await assignedCase();
    const sourceId = await sourceWithBody(caseId, "Left at the door on 2 March.");
    const assumption = await recordAssumption({ ...actor(caseId), text: "The dates may differ.", origin: "ANALYST_NOTE" });
    if (!assumption.ok) throw new Error(assumption.reason);
    if (!(await acknowledgeAssumption({ ...actor(caseId), assumptionId: assumption.data.id })).ok) throw new Error("ack failed");

    const invented = await runClaimDecomposition(actor(caseId), mockModel(JSON.stringify({
      claims: [{ claim_type: "fact", text: "The parcel arrived on 2 March.", excerpt: "arrived before noon", source_id: sourceId }],
    }), { n: 0 }));
    expect(invented.ok).toBe(false);
    expect(await prisma.pipelineProposal.count({ where: { caseId } })).toBe(0);
    expect(await prisma.event.findFirst({ where: { caseId, type: "PROPOSAL_REJECTED" } })).toBeTruthy();

    const absolute = await runClaimDecomposition(actor(caseId), mockModel(JSON.stringify({
      claims: [{ claim_type: "fact", text: "The merchant is impartial.", excerpt: "Left at the door on 2 March.", source_id: sourceId }],
    }), { n: 0 }));
    expect(absolute.ok).toBe(false);
    expect(await prisma.claim.count({ where: { caseId } })).toBe(0);
  });

  it("logs a mid-case assumption and a return without deleting earlier proposals", async () => {
    const caseId = await assignedCase();
    const excerpt = "Left at the door on 2 March.";
    const sourceId = await sourceWithBody(caseId, excerpt);
    const assumption = await recordAssumption({ ...actor(caseId), text: "The dates may differ.", origin: "CASE_FRAMING" });
    if (!assumption.ok) throw new Error(assumption.reason);
    if (!(await acknowledgeAssumption({ ...actor(caseId), assumptionId: assumption.data.id })).ok) throw new Error("ack failed");
    const proposed = await runClaimDecomposition(actor(caseId), mockModel(JSON.stringify({
      claims: [{ claim_type: "fact", text: "The parcel was left at the door on 2 March.", excerpt, source_id: sourceId }],
    }), { n: 0 }));
    if (!proposed.ok) throw new Error(proposed.reason);

    const added = await recordAssumption({ ...actor(caseId), text: "The invoice date may have been typed later.", origin: "ANALYST_NOTE" });
    if (!added.ok) throw new Error(added.reason);
    const events = await prisma.event.findMany({ where: { caseId }, orderBy: { seq: "asc" } });
    expect(events.some((event) => event.type === "ASSUMPTION_ADDED_MID_CASE")).toBe(true);
    expect(events.some((event) => event.type === "PIPELINE_RETURNED")).toBe(true);
    expect(await prisma.pipelineProposal.count({ where: { id: proposed.data.ids[0] } })).toBe(1);
    const visible = await prisma.assumption.findUniqueOrThrow({ where: { id: added.data.id } });
    expect(visible.origin).toBe("MID_CASE");
    expect(visible.deletedAt).toBeNull();

    const returned = await returnToStage({ ...actor(caseId), toStage: "CLAIM_DECOMPOSITION", reason: "The new assumption needs another pass." });
    if (!returned.ok) throw new Error(returned.reason);
    expect(await prisma.pipelineProposal.count({ where: { caseId } })).toBe(1);
    const revised = await reviseAssumption({ ...actor(caseId), assumptionId: assumption.data.id, text: "The dates may differ, and the invoice may have been typed later." });
    if (!revised.ok) throw new Error(revised.reason);
    const original = await prisma.assumption.findUniqueOrThrow({ where: { id: assumption.data.id } });
    expect(original.status).toBe("REVISED");
    expect(original.text).toBe("The dates may differ.");
  });

  it("rejects an unlinked synthesis and keeps disputed claims in the disputed section of every synthesis that cites them", async () => {
    const caseId = await assignedCase();
    const excerpt = "Left at the door on 2 March.";
    const sourceId = await sourceWithBody(caseId, excerpt);
    const assumption = await recordAssumption({ ...actor(caseId), text: "The dates may differ.", origin: "CASE_FRAMING" });
    if (!assumption.ok) throw new Error(assumption.reason);
    if (!(await acknowledgeAssumption({ ...actor(caseId), assumptionId: assumption.data.id })).ok) throw new Error("ack failed");
    const proposed = await runClaimDecomposition(actor(caseId), mockModel(JSON.stringify({
      claims: [{ claim_type: "fact", text: "The parcel was left at the door on 2 March.", excerpt, source_id: sourceId }],
    }), { n: 0 }));
    if (!proposed.ok) throw new Error(proposed.reason);
    const accepted = await acceptClaimProposal({
      ...actor(caseId),
      proposalId: proposed.data.ids[0],
      confidence: "DISPUTED",
      confidenceRationale: "The invoice is not yet in the file.",
      locale: "en-CA",
    });
    if (!accepted.ok) throw new Error(accepted.reason);

    const context = await runContextMapping(actor(caseId), mockModel(JSON.stringify({
      context_factors: [{
        factor_type: "policy_vs_practice",
        description: "The posted window and the delivery note do not name the same date.",
        gap_map: { policy: "posted window", practice: "delivery note" },
        diagnosis: "no_gap_found",
        evidence_id: sourceId,
      }],
    }), { n: 0 }));
    if (!context.ok) throw new Error(context.reason);
    expect(await prisma.claim.count({ where: { caseId } })).toBe(1);
    expect(await prisma.contextFactor.count({ where: { caseId } })).toBe(0);
    const factor = await acceptContextProposal({ ...actor(caseId), proposalId: context.data.ids[0] });
    if (!factor.ok) throw new Error(factor.reason);
    expect(await prisma.claim.count({ where: { caseId } })).toBe(1);

    const loose = assembleSynthesis({
      claims: [{
        id: accepted.data.claimId,
        text: "The parcel was left at the door on 2 March.",
        claimType: "FACTUAL",
        confidence: "DISPUTED",
        status: "DISPUTED",
        doNotSummarizeAsSettled: false,
      }],
      links: [{ claimId: accepted.data.claimId, sourceId, excerpt }],
      hasContextFactor: true,
    });
    loose.sections.unknown.push({ id: "loose", text: "Something else happened off the page." });
    const rejected = await recordSynthesis({ ...actor(caseId), draft: loose });
    expect(rejected.ok).toBe(false);
    expect(await prisma.synthesisVersion.count({ where: { caseId } })).toBe(0);
    expect(await prisma.event.findFirst({ where: { caseId, type: "SYNTHESIS_REJECTED" } })).toBeTruthy();

    const first = await assembleAndRecordSynthesis(actor(caseId));
    if (!first.ok) throw new Error(first.reason);
    const second = await assembleAndRecordSynthesis(actor(caseId));
    if (!second.ok) throw new Error(second.reason);
    const versions = await prisma.synthesisVersion.findMany({ where: { caseId }, orderBy: { version: "asc" } });
    expect(versions).toHaveLength(2);
    for (const version of versions) {
      const sections = version.sections as { disputed: Array<{ text: string }> };
      expect(sections.disputed.map((sentence) => sentence.text)).toContain("The parcel was left at the door on 2 March.");
      expect(version.diagE).toBe("disputed_present");
      expect(version.diagP).toBe("positionality_gap");
      expect(version.diagC).toBe("third_factor_recorded");
      expect(Number.isFinite(Number(version.diagE))).toBe(false);
    }

    const moved = assembleSynthesis({
      claims: [{
        id: accepted.data.claimId,
        text: "The parcel was left at the door on 2 March.",
        claimType: "FACTUAL",
        confidence: "ESTABLISHED",
        status: "OPEN",
        doNotSummarizeAsSettled: false,
      }],
      links: [{ claimId: accepted.data.claimId, sourceId, excerpt }],
      hasContextFactor: true,
    });
    const hidden = await recordSynthesis({ ...actor(caseId), draft: moved });
    expect(hidden.ok).toBe(false);
    expect(await prisma.synthesisVersion.count({ where: { caseId } })).toBe(2);
  });
});
