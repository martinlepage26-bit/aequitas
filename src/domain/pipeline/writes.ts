import type { AssumptionOrigin, ClaimType, GlobalRole, PipelineStageName, Prisma } from "../../generated/prisma";
import { prisma } from "../../lib/prisma";
import { caseReadAccess, type CaseReadAccess } from "../caseAccess";
import { claimWritePermission } from "../claimWrites";
import { appendEvent } from "../events";
import type { MutationOutcome } from "../mutate";
import { absoluteClaimHit } from "./absoluteClaims";
import { parseAssumptionResponse, parseClaimResponse, parseContextResponse, type ProposedClaim, type ProposedContextFactor } from "./contracts";
import { PIPELINE_OFF_REASON, pipelineEnabled } from "./flag";
import { resolveFreeTextModel, type TextCompletion } from "./provider";
import { assembleSynthesis, validateSynthesis, type SynthesisDraft } from "./synthesis";
import { excerptIsVerbatim } from "./verbatim";

export const PIPELINE_PROMPT_VERSION = "phase2-pipeline-v1";

const ASSUMPTION_ORIGINS = ["CASE_FRAMING", "PARTY_STATEMENT", "ANALYST_NOTE", "MID_CASE"] as const;
const STAGES = ["EPOCHE", "CLAIM_DECOMPOSITION", "CONTEXT_MAPPING", "SYNTHESIS"] as const;

export interface ActorInput {
  actorId: string;
  actorRole: GlobalRole;
  caseId: string;
}

function off(): MutationOutcome<never> {
  return { ok: false, step: "guard", reason: PIPELINE_OFF_REASON };
}

function guard(reason: string): MutationOutcome<never> {
  return { ok: false, step: "guard", reason };
}

async function authorize(input: ActorInput) {
  const caseRow = await prisma.case.findUnique({ where: { id: input.caseId } });
  if (!caseRow) return { ok: false as const, step: "not-found" as const, reason: "Case not found." };
  const access = caseReadAccess(caseRow, { userId: input.actorId, globalRole: input.actorRole });
  const permission = claimWritePermission({ access, globalRole: input.actorRole });
  if (!permission.ok) return permission;
  return { ok: true as const, caseRow };
}

async function pastLedger(tx: Prisma.TransactionClient, caseId: string): Promise<{ mid: boolean; stage: PipelineStageName }> {
  const pipeline = await tx.casePipeline.findUnique({ where: { caseId } });
  const stage = pipeline?.stage ?? "EPOCHE";
  if (stage !== "EPOCHE") return { mid: true, stage };
  const proposals = await tx.pipelineProposal.count({ where: { caseId } });
  if (proposals > 0) return { mid: true, stage };
  const syntheses = await tx.synthesisVersion.count({ where: { caseId } });
  return { mid: syntheses > 0, stage };
}

async function ensureStage(tx: Prisma.TransactionClient, caseId: string, stage: PipelineStageName) {
  await tx.casePipeline.upsert({
    where: { caseId },
    create: { caseId, stage },
    update: { stage },
  });
}

async function acknowledgedCount(caseId: string): Promise<number> {
  return prisma.assumption.count({ where: { caseId, status: "ACKNOWLEDGED", deletedAt: null } });
}

function assumptionPrompt(description: string): string {
  return [
    "Extract assumptions already present in this case framing.",
    "Return JSON only: {\"assumptions\":[{\"text\":\"...\",\"origin\":\"case_framing\"}]}.",
    "origin is case_framing, party_statement, analyst_note, or mid_case.",
    "Do not say a party is impartial, compliant, or free of bias. Do not assign a decision or a score.",
    `Case framing: ${description}`,
  ].join("\n");
}

function claimPrompt(sources: Array<{ id: string; title: string; body: string }>): string {
  return [
    "Decompose the source text into claims. Return JSON only.",
    "{\"claims\":[{\"claim_type\":\"fact\",\"text\":\"...\",\"excerpt\":\"...\",\"source_id\":\"...\"}]}",
    "claim_type is fact, causal, moral, identity, policy, or impact.",
    "excerpt must be copied verbatim from the named source. Do not invent text.",
    "Do not say a party is impartial, compliant, or free of bias. Do not assign a decision or a score.",
    ...sources.map((source) => `SOURCE ${source.id} (${source.title})\n${source.body.slice(0, 8000)}`),
  ].join("\n\n");
}

function contextPrompt(claims: Array<{ id: string; text: string }>, evidenceIds: string[]): string {
  return [
    "Map context factors. Return JSON only.",
    "{\"context_factors\":[{\"factor_type\":\"policy_vs_practice\",\"description\":\"...\",\"gap_map\":{},\"diagnosis\":\"no_gap_found\",\"evidence_id\":\"...\"}]}",
    "factor_type is policy_vs_practice, interfaces_vs_dependencies, or authority_vs_implementation.",
    "diagnosis is adaptive, protective, evasive, fraudulent, or no_gap_found.",
    "evidence_id must be one of the ids listed below.",
    "Do not say a party is impartial, compliant, or free of bias. Do not assign a decision or a score.",
    ...claims.map((claim) => `CLAIM ${claim.id}: ${claim.text}`),
    `Evidence ids: ${evidenceIds.join(", ")}`,
  ].join("\n");
}

async function rejectModelOutput(caseId: string, actorId: string, stage: string, reason: string) {
  await prisma.$transaction(async (tx) => {
    await appendEvent(tx, {
      caseId,
      type: "PROPOSAL_REJECTED",
      actorId,
      payload: { stage, reason, modelOutputStored: false },
    });
  });
}

export async function recordAssumption(input: ActorInput & { text: string; origin: AssumptionOrigin }): Promise<MutationOutcome<{ id: string }>> {
  if (!pipelineEnabled()) return off();
  const text = input.text.trim();
  if (!text || text.length > 4000) return guard("An assumption needs text.");
  if (!ASSUMPTION_ORIGINS.includes(input.origin)) return guard("That assumption origin is not recognized.");
  if (absoluteClaimHit(text)) return guard("An assumption cannot use an absolute claim.");
  const auth = await authorize(input);
  if (!auth.ok) return auth;

  const id = await prisma.$transaction(async (tx) => {
    const { mid, stage } = await pastLedger(tx, input.caseId);
    const origin = mid ? "MID_CASE" : input.origin;
    const row = await tx.assumption.create({
      data: { caseId: input.caseId, text, origin, status: "PROPOSED", createdById: input.actorId },
    });
    await ensureStage(tx, input.caseId, mid ? "EPOCHE" : stage);
    await appendEvent(tx, {
      caseId: input.caseId,
      type: mid ? "ASSUMPTION_ADDED_MID_CASE" : "ASSUMPTION_RECORDED",
      actorId: input.actorId,
      payload: { assumptionId: row.id, origin, status: "PROPOSED" },
    });
    if (mid) {
      await appendEvent(tx, {
        caseId: input.caseId,
        type: "PIPELINE_RETURNED",
        actorId: input.actorId,
        payload: { fromStage: stage, toStage: "EPOCHE", reason: "A mid-case assumption was added." },
      });
    }
    return row.id;
  });
  return { ok: true, data: { id } };
}

export async function acknowledgeAssumption(input: ActorInput & { assumptionId: string }): Promise<MutationOutcome<{ id: string }>> {
  if (!pipelineEnabled()) return off();
  const auth = await authorize(input);
  if (!auth.ok) return auth;
  try {
    const id = await prisma.$transaction(async (tx) => {
      const row = await tx.assumption.findFirst({ where: { id: input.assumptionId, caseId: input.caseId, deletedAt: null } });
      if (!row) throw new Error("missing");
      if (row.status === "ACKNOWLEDGED") throw new Error("already");
      await tx.assumption.update({
        where: { id: row.id },
        data: { status: "ACKNOWLEDGED", acknowledgedById: input.actorId, acknowledgedAt: new Date() },
      });
      await appendEvent(tx, {
        caseId: input.caseId,
        type: "ASSUMPTION_ACKNOWLEDGED",
        actorId: input.actorId,
        payload: { assumptionId: row.id },
      });
      return row.id;
    });
    return { ok: true, data: { id } };
  } catch (error) {
    if (error instanceof Error && error.message === "missing") return guard("That assumption is not on this case.");
    if (error instanceof Error && error.message === "already") return guard("That assumption is already acknowledged.");
    throw error;
  }
}

export async function challengeAssumption(input: ActorInput & { assumptionId: string }): Promise<MutationOutcome<{ id: string }>> {
  if (!pipelineEnabled()) return off();
  const auth = await authorize(input);
  if (!auth.ok) return auth;
  try {
    const id = await prisma.$transaction(async (tx) => {
      const row = await tx.assumption.findFirst({ where: { id: input.assumptionId, caseId: input.caseId, deletedAt: null } });
      if (!row) throw new Error("missing");
      await tx.assumption.update({ where: { id: row.id }, data: { status: "CHALLENGED", acknowledgedById: null, acknowledgedAt: null } });
      await appendEvent(tx, {
        caseId: input.caseId,
        type: "ASSUMPTION_CHALLENGED",
        actorId: input.actorId,
        payload: { assumptionId: row.id },
      });
      return row.id;
    });
    return { ok: true, data: { id } };
  } catch (error) {
    if (error instanceof Error && error.message === "missing") return guard("That assumption is not on this case.");
    throw error;
  }
}

export async function reviseAssumption(input: ActorInput & { assumptionId: string; text: string }): Promise<MutationOutcome<{ id: string }>> {
  if (!pipelineEnabled()) return off();
  const text = input.text.trim();
  if (!text || text.length > 4000) return guard("A revised assumption needs text.");
  if (absoluteClaimHit(text)) return guard("An assumption cannot use an absolute claim.");
  const auth = await authorize(input);
  if (!auth.ok) return auth;
  try {
    const id = await prisma.$transaction(async (tx) => {
      const row = await tx.assumption.findFirst({ where: { id: input.assumptionId, caseId: input.caseId, deletedAt: null } });
      if (!row) throw new Error("missing");
      await tx.assumption.update({ where: { id: row.id }, data: { status: "REVISED" } });
      await appendEvent(tx, {
        caseId: input.caseId,
        type: "ASSUMPTION_REVISED",
        actorId: input.actorId,
        payload: { assumptionId: row.id, previousTextKept: true },
      });
      const { mid, stage } = await pastLedger(tx, input.caseId);
      const created = await tx.assumption.create({
        data: { caseId: input.caseId, text, origin: mid ? "MID_CASE" : row.origin, status: "PROPOSED", createdById: input.actorId },
      });
      await appendEvent(tx, {
        caseId: input.caseId,
        type: mid ? "ASSUMPTION_ADDED_MID_CASE" : "ASSUMPTION_RECORDED",
        actorId: input.actorId,
        payload: { assumptionId: created.id, revises: row.id, origin: created.origin },
      });
      if (mid) {
        await ensureStage(tx, input.caseId, "EPOCHE");
        await appendEvent(tx, {
          caseId: input.caseId,
          type: "PIPELINE_RETURNED",
          actorId: input.actorId,
          payload: { fromStage: stage, toStage: "EPOCHE", reason: "A revised assumption was added." },
        });
      }
      return created.id;
    });
    return { ok: true, data: { id } };
  } catch (error) {
    if (error instanceof Error && error.message === "missing") return guard("That assumption is not on this case.");
    throw error;
  }
}

async function completionFor(injected?: TextCompletion): Promise<{ ok: true; model: TextCompletion } | { ok: false; reason: string }> {
  if (!pipelineEnabled()) return { ok: false, reason: PIPELINE_OFF_REASON };
  if (injected) return { ok: true, model: injected };
  return resolveFreeTextModel();
}

export async function runAssumptionExtraction(input: ActorInput, injected?: TextCompletion): Promise<MutationOutcome<{ ids: string[] }>> {
  const model = await completionFor(injected);
  if (!model.ok) return model.ok === false && model.reason === PIPELINE_OFF_REASON ? off() : guard(model.reason);
  const auth = await authorize(input);
  if (!auth.ok) return auth;
  const description = auth.caseRow.disputeDescription?.trim() || "";
  if (!description) return guard("The case has no framing text to read.");
  let raw: string;
  try {
    raw = await model.model.complete(assumptionPrompt(description));
  } catch (error) {
    console.error("Assumption extraction failed:", error instanceof Error ? error.name : "error");
    return guard("The free model did not return a usable response.");
  }
  const parsed = parseAssumptionResponse(raw);
  if (!parsed.ok) {
    await rejectModelOutput(input.caseId, input.actorId, "EPOCHE", parsed.reason);
    return guard(parsed.reason);
  }
  const ids = await prisma.$transaction(async (tx) => {
    const { mid, stage } = await pastLedger(tx, input.caseId);
    const created: string[] = [];
    for (const assumption of parsed.assumptions) {
      const row = await tx.assumption.create({
        data: {
          caseId: input.caseId,
          text: assumption.text,
          origin: mid ? "MID_CASE" : assumption.origin,
          status: "PROPOSED",
          createdById: input.actorId,
        },
      });
      created.push(row.id);
      await appendEvent(tx, {
        caseId: input.caseId,
        type: mid ? "ASSUMPTION_ADDED_MID_CASE" : "ASSUMPTION_RECORDED",
        actorId: input.actorId,
        payload: { assumptionId: row.id, origin: mid ? "MID_CASE" : assumption.origin, modelId: model.model.model, proposed: true },
      });
    }
    if (mid) {
      await ensureStage(tx, input.caseId, "EPOCHE");
      await appendEvent(tx, {
        caseId: input.caseId,
        type: "PIPELINE_RETURNED",
        actorId: input.actorId,
        payload: { fromStage: stage, toStage: "EPOCHE", reason: "A mid-case assumption was added." },
      });
    } else {
      await ensureStage(tx, input.caseId, "EPOCHE");
    }
    return created;
  });
  return { ok: true, data: { ids } };
}

export async function runClaimDecomposition(input: ActorInput, injected?: TextCompletion): Promise<MutationOutcome<{ ids: string[] }>> {
  if (!pipelineEnabled()) return off();
  const auth = await authorize(input);
  if (!auth.ok) return auth;
  if ((await acknowledgedCount(input.caseId)) < 1) {
    return guard("Claim decomposition waits until a person acknowledges an assumption.");
  }
  const sources = await prisma.source.findMany({
    where: { caseId: input.caseId, deletedAt: null, body: { not: null } },
    select: { id: true, title: true, body: true },
  });
  const withBody = sources.filter((source): source is { id: string; title: string; body: string } => Boolean(source.body?.trim()));
  if (withBody.length === 0) return guard("Claim decomposition needs source text to check excerpts against.");
  const model = await completionFor(injected);
  if (!model.ok) return guard(model.reason);
  let raw: string;
  try {
    raw = await model.model.complete(claimPrompt(withBody));
  } catch (error) {
    console.error("Claim decomposition failed:", error instanceof Error ? error.name : "error");
    return guard("The free model did not return a usable response.");
  }
  const parsed = parseClaimResponse(raw);
  if (!parsed.ok) {
    await rejectModelOutput(input.caseId, input.actorId, "CLAIM_DECOMPOSITION", parsed.reason);
    return guard(parsed.reason);
  }
  const bodies = new Map(withBody.map((source) => [source.id, source.body]));
  for (const claim of parsed.claims) {
    if (!excerptIsVerbatim(claim.excerpt, bodies.get(claim.sourceId))) {
      await rejectModelOutput(input.caseId, input.actorId, "CLAIM_DECOMPOSITION", "An excerpt is not a verbatim substring of the source.");
      return guard("An excerpt is not a verbatim substring of the source.");
    }
  }
  const ids = await storeClaimProposals(input, parsed.claims, model.model.model);
  return { ok: true, data: { ids } };
}

async function storeClaimProposals(input: ActorInput, claims: ProposedClaim[], modelId: string): Promise<string[]> {
  return prisma.$transaction(async (tx) => {
    const ids: string[] = [];
    for (const claim of claims) {
      const row = await tx.pipelineProposal.create({
        data: {
          caseId: input.caseId,
          kind: "CLAIM",
          status: "PROPOSED",
          payload: claim as unknown as Prisma.InputJsonValue,
          modelId,
          promptVersion: PIPELINE_PROMPT_VERSION,
        },
      });
      ids.push(row.id);
      await appendEvent(tx, {
        caseId: input.caseId,
        type: "PROPOSAL_RECORDED",
        actorId: input.actorId,
        payload: { proposalId: row.id, kind: "CLAIM", modelId },
      });
    }
    await ensureStage(tx, input.caseId, "CLAIM_DECOMPOSITION");
    return ids;
  });
}

export async function acceptClaimProposal(input: ActorInput & {
  proposalId: string;
  confidence: "ESTABLISHED" | "PROBABLE" | "DISPUTED" | "UNKNOWN";
  confidenceRationale?: string | null;
  locale: "fr-CA" | "en-CA";
}): Promise<MutationOutcome<{ claimId: string }>> {
  if (!pipelineEnabled()) return off();
  const rationale = input.confidenceRationale?.trim() || null;
  if ((input.confidence === "DISPUTED" || input.confidence === "UNKNOWN") && !rationale) {
    return guard("A disputed or unknown claim needs a rationale naming what is missing.");
  }
  const auth = await authorize(input);
  if (!auth.ok) return auth;
  try {
    const claimId = await prisma.$transaction(async (tx) => {
      const proposal = await tx.pipelineProposal.findFirst({ where: { id: input.proposalId, caseId: input.caseId } });
      if (!proposal || proposal.kind !== "CLAIM" || proposal.status !== "PROPOSED") throw new Error("missing");
      const payload = proposal.payload as unknown as ProposedClaim;
      if (absoluteClaimHit(`${payload.text}\n${payload.excerpt}`)) throw new Error("absolute");
      const source = await tx.source.findFirst({ where: { id: payload.sourceId, caseId: input.caseId, deletedAt: null } });
      if (!source || !excerptIsVerbatim(payload.excerpt, source.body)) throw new Error("excerpt");
      const claim = await tx.claim.create({
        data: {
          caseId: input.caseId,
          claimType: payload.claimType as ClaimType,
          text: payload.text,
          confidence: input.confidence,
          confidenceRationale: rationale,
          status: input.confidence === "DISPUTED" ? "DISPUTED" : "OPEN",
          locale: input.locale,
          doNotSummarizeAsSettled: payload.claimType === "IMPACT_STATEMENT",
          createdById: input.actorId,
        },
      });
      await appendEvent(tx, {
        caseId: input.caseId,
        type: "CLAIM_RECORDED",
        actorId: input.actorId,
        payload: { claimId: claim.id, claimType: claim.claimType, confidence: claim.confidence, proposalId: proposal.id },
      });
      const link = await tx.claimEvidenceLink.create({
        data: {
          claimId: claim.id,
          sourceId: source.id,
          predicate: "ORIGINATES_FROM",
          excerpt: payload.excerpt.trim(),
          rationale: "Accepted from a pipeline proposal.",
          createdById: input.actorId,
        },
      });
      await appendEvent(tx, {
        caseId: input.caseId,
        type: "CLAIM_EVIDENCE_LINKED",
        actorId: input.actorId,
        payload: { claimId: claim.id, linkId: link.id, sourceId: source.id, predicate: link.predicate },
      });
      await tx.pipelineProposal.update({
        where: { id: proposal.id },
        data: { status: "ACCEPTED", reviewedById: input.actorId, reviewedAt: new Date(), acceptedClaimId: claim.id },
      });
      await appendEvent(tx, {
        caseId: input.caseId,
        type: "PROPOSAL_ACCEPTED",
        actorId: input.actorId,
        payload: { proposalId: proposal.id, claimId: claim.id },
      });
      return claim.id;
    });
    return { ok: true, data: { claimId } };
  } catch (error) {
    if (error instanceof Error && error.message === "missing") return guard("That proposal is not awaiting acceptance.");
    if (error instanceof Error && error.message === "absolute") return guard("A proposed claim uses an absolute claim.");
    if (error instanceof Error && error.message === "excerpt") return guard("An excerpt is not a verbatim substring of the source.");
    throw error;
  }
}

export async function rejectProposal(input: ActorInput & { proposalId: string }): Promise<MutationOutcome<{ id: string }>> {
  if (!pipelineEnabled()) return off();
  const auth = await authorize(input);
  if (!auth.ok) return auth;
  try {
    const id = await prisma.$transaction(async (tx) => {
      const proposal = await tx.pipelineProposal.findFirst({ where: { id: input.proposalId, caseId: input.caseId, status: "PROPOSED" } });
      if (!proposal) throw new Error("missing");
      await tx.pipelineProposal.update({
        where: { id: proposal.id },
        data: { status: "REJECTED", reviewedById: input.actorId, reviewedAt: new Date() },
      });
      await appendEvent(tx, {
        caseId: input.caseId,
        type: "PROPOSAL_REJECTED",
        actorId: input.actorId,
        payload: { proposalId: proposal.id, kind: proposal.kind },
      });
      return proposal.id;
    });
    return { ok: true, data: { id } };
  } catch (error) {
    if (error instanceof Error && error.message === "missing") return guard("That proposal is not awaiting acceptance.");
    throw error;
  }
}

export async function runContextMapping(input: ActorInput, injected?: TextCompletion): Promise<MutationOutcome<{ ids: string[] }>> {
  if (!pipelineEnabled()) return off();
  const auth = await authorize(input);
  if (!auth.ok) return auth;
  if ((await acknowledgedCount(input.caseId)) < 1) {
    return guard("Context mapping waits until a person acknowledges an assumption.");
  }
  const claims = await prisma.claim.findMany({
    where: { caseId: input.caseId, deletedAt: null },
    select: { id: true, text: true },
  });
  if (claims.length === 0) return guard("Context mapping waits until a proposal has been accepted as a claim.");
  const sources = await prisma.source.findMany({ where: { caseId: input.caseId, deletedAt: null }, select: { id: true } });
  const evidenceIds = [...claims.map((claim) => claim.id), ...sources.map((source) => source.id)];
  const model = await completionFor(injected);
  if (!model.ok) return guard(model.reason);
  let raw: string;
  try {
    raw = await model.model.complete(contextPrompt(claims, evidenceIds));
  } catch (error) {
    console.error("Context mapping failed:", error instanceof Error ? error.name : "error");
    return guard("The free model did not return a usable response.");
  }
  const parsed = parseContextResponse(raw);
  if (!parsed.ok) {
    await rejectModelOutput(input.caseId, input.actorId, "CONTEXT_MAPPING", parsed.reason);
    return guard(parsed.reason);
  }
  const known = new Set(evidenceIds);
  if (parsed.factors.some((factor) => !known.has(factor.evidenceId))) {
    await rejectModelOutput(input.caseId, input.actorId, "CONTEXT_MAPPING", "A context factor cites evidence that is not on this case.");
    return guard("A context factor cites evidence that is not on this case.");
  }
  const ids = await storeContextProposals(input, parsed.factors, model.model.model);
  return { ok: true, data: { ids } };
}

async function storeContextProposals(input: ActorInput, factors: ProposedContextFactor[], modelId: string): Promise<string[]> {
  return prisma.$transaction(async (tx) => {
    const ids: string[] = [];
    for (const factor of factors) {
      const row = await tx.pipelineProposal.create({
        data: {
          caseId: input.caseId,
          kind: "CONTEXT_FACTOR",
          status: "PROPOSED",
          payload: factor as unknown as Prisma.InputJsonValue,
          modelId,
          promptVersion: PIPELINE_PROMPT_VERSION,
        },
      });
      ids.push(row.id);
      await appendEvent(tx, {
        caseId: input.caseId,
        type: "PROPOSAL_RECORDED",
        actorId: input.actorId,
        payload: { proposalId: row.id, kind: "CONTEXT_FACTOR", modelId },
      });
    }
    await ensureStage(tx, input.caseId, "CONTEXT_MAPPING");
    return ids;
  });
}

export async function acceptContextProposal(input: ActorInput & { proposalId: string }): Promise<MutationOutcome<{ id: string }>> {
  if (!pipelineEnabled()) return off();
  const auth = await authorize(input);
  if (!auth.ok) return auth;
  try {
    const id = await prisma.$transaction(async (tx) => {
      const proposal = await tx.pipelineProposal.findFirst({ where: { id: input.proposalId, caseId: input.caseId } });
      if (!proposal || proposal.kind !== "CONTEXT_FACTOR" || proposal.status !== "PROPOSED") throw new Error("missing");
      const payload = proposal.payload as unknown as ProposedContextFactor;
      if (absoluteClaimHit(payload.description)) throw new Error("absolute");
      const [source, claim] = await Promise.all([
        tx.source.findFirst({ where: { id: payload.evidenceId, caseId: input.caseId, deletedAt: null }, select: { id: true } }),
        tx.claim.findFirst({ where: { id: payload.evidenceId, caseId: input.caseId, deletedAt: null }, select: { id: true } }),
      ]);
      if (!source && !claim) throw new Error("evidence");
      const factor = await tx.contextFactor.create({
        data: {
          caseId: input.caseId,
          factorType: payload.factorType,
          description: payload.description,
          gapMap: payload.gapMap as Prisma.InputJsonValue,
          diagnosis: payload.diagnosis,
          evidenceId: payload.evidenceId,
          proposalId: proposal.id,
          createdById: input.actorId,
        },
      });
      await tx.pipelineProposal.update({
        where: { id: proposal.id },
        data: { status: "ACCEPTED", reviewedById: input.actorId, reviewedAt: new Date() },
      });
      await appendEvent(tx, {
        caseId: input.caseId,
        type: "CONTEXT_FACTOR_RECORDED",
        actorId: input.actorId,
        payload: { contextFactorId: factor.id, proposalId: proposal.id, factorType: factor.factorType },
      });
      await appendEvent(tx, {
        caseId: input.caseId,
        type: "PROPOSAL_ACCEPTED",
        actorId: input.actorId,
        payload: { proposalId: proposal.id, contextFactorId: factor.id },
      });
      return factor.id;
    });
    return { ok: true, data: { id } };
  } catch (error) {
    if (error instanceof Error && error.message === "missing") return guard("That proposal is not awaiting acceptance.");
    if (error instanceof Error && error.message === "absolute") return guard("A context factor uses an absolute claim.");
    if (error instanceof Error && error.message === "evidence") return guard("A context factor cites evidence that is not on this case.");
    throw error;
  }
}

export async function returnToStage(input: ActorInput & { toStage: PipelineStageName; reason: string }): Promise<MutationOutcome<{ stage: PipelineStageName }>> {
  if (!pipelineEnabled()) return off();
  const reason = input.reason.trim();
  if (!reason || reason.length > 2000) return guard("A return needs a reason.");
  if (!STAGES.includes(input.toStage)) return guard("That stage is not part of the pipeline.");
  if (absoluteClaimHit(reason)) return guard("A return reason cannot use an absolute claim.");
  const auth = await authorize(input);
  if (!auth.ok) return auth;
  const stage = await prisma.$transaction(async (tx) => {
    const current = await tx.casePipeline.findUnique({ where: { caseId: input.caseId } });
    const fromStage = current?.stage ?? "EPOCHE";
    await ensureStage(tx, input.caseId, input.toStage);
    await appendEvent(tx, {
      caseId: input.caseId,
      type: "PIPELINE_RETURNED",
      actorId: input.actorId,
      payload: { fromStage, toStage: input.toStage, reason },
    });
    return input.toStage;
  });
  return { ok: true, data: { stage } };
}

async function synthesisContext(caseId: string) {
  const [claims, links, sources, factors] = await Promise.all([
    prisma.claim.findMany({ where: { caseId, deletedAt: null } }),
    prisma.claimEvidenceLink.findMany({ where: { claim: { caseId }, deletedAt: null } }),
    prisma.source.findMany({ where: { caseId, deletedAt: null }, select: { id: true } }),
    prisma.contextFactor.count({ where: { caseId, deletedAt: null } }),
  ]);
  return { claims, links, sourceIds: new Set(sources.map((source) => source.id)), hasContextFactor: factors > 0 };
}

export async function recordSynthesis(input: ActorInput & { draft: unknown; modelId?: string | null }): Promise<MutationOutcome<{ id: string }>> {
  if (!pipelineEnabled()) return off();
  const auth = await authorize(input);
  if (!auth.ok) return auth;
  const context = await synthesisContext(input.caseId);
  const validation = validateSynthesis(input.draft, {
    claims: context.claims,
    sourceIds: context.sourceIds,
  });
  if (!validation.ok) {
    await prisma.$transaction(async (tx) => {
      await appendEvent(tx, {
        caseId: input.caseId,
        type: "SYNTHESIS_REJECTED",
        actorId: input.actorId,
        payload: { reasons: validation.reasons },
      });
    });
    return guard(validation.reasons.join(" "));
  }
  const draft = input.draft as SynthesisDraft;
  const id = await prisma.$transaction(async (tx) => {
    const latest = await tx.synthesisVersion.findFirst({ where: { caseId: input.caseId }, orderBy: { version: "desc" }, select: { version: true } });
    const row = await tx.synthesisVersion.create({
      data: {
        caseId: input.caseId,
        version: (latest?.version ?? 0) + 1,
        sections: draft.sections as unknown as Prisma.InputJsonValue,
        sentenceMap: draft.sentence_map as unknown as Prisma.InputJsonValue,
        diagE: draft.diag_e,
        diagP: draft.diag_p,
        diagC: draft.diag_c,
        modelId: input.modelId ?? null,
        createdById: input.actorId,
      },
    });
    await ensureStage(tx, input.caseId, "SYNTHESIS");
    await appendEvent(tx, {
      caseId: input.caseId,
      type: "SYNTHESIS_RECORDED",
      actorId: input.actorId,
      payload: { synthesisId: row.id, version: row.version, diagE: row.diagE, diagP: row.diagP, diagC: row.diagC },
    });
    return row.id;
  });
  return { ok: true, data: { id } };
}

export async function assembleAndRecordSynthesis(input: ActorInput): Promise<MutationOutcome<{ id: string }>> {
  if (!pipelineEnabled()) return off();
  const context = await synthesisContext(input.caseId);
  const draft = assembleSynthesis({
    claims: context.claims,
    links: context.links,
    hasContextFactor: context.hasContextFactor,
  });
  return recordSynthesis({ ...input, draft, modelId: null });
}

export interface PipelineAssumptionView {
  id: string;
  text: string;
  origin: string;
  status: string;
}

export interface PipelineProposalView {
  id: string;
  kind: string;
  status: string;
  text: string;
  excerpt: string | null;
}

export interface PipelineView {
  stage: string;
  assumptions: PipelineAssumptionView[];
  proposals: PipelineProposalView[];
  synthesis: { version: number; diagE: string; diagP: string; diagC: string; sections: SynthesisDraft["sections"] } | null;
  canAuthor: boolean;
}

function proposalText(kind: string, payload: unknown): { text: string; excerpt: string | null } {
  const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  if (kind === "CLAIM") {
    return {
      text: typeof record.text === "string" ? record.text : "",
      excerpt: typeof record.excerpt === "string" ? record.excerpt : null,
    };
  }
  return { text: typeof record.description === "string" ? record.description : "", excerpt: null };
}

export async function readPipeline(caseId: string, session: { userId: string; globalRole: GlobalRole }): Promise<PipelineView | null> {
  const caseRow = await prisma.case.findUnique({ where: { id: caseId } });
  if (!caseRow) return null;
  const access: CaseReadAccess | null = caseReadAccess(caseRow, session);
  if (!access) return null;
  const [pipeline, assumptions, proposals, synthesis] = await Promise.all([
    prisma.casePipeline.findUnique({ where: { caseId } }),
    prisma.assumption.findMany({ where: { caseId, deletedAt: null }, orderBy: { createdAt: "asc" } }),
    prisma.pipelineProposal.findMany({ where: { caseId }, orderBy: { createdAt: "asc" } }),
    prisma.synthesisVersion.findFirst({ where: { caseId }, orderBy: { version: "desc" } }),
  ]);
  const permission = claimWritePermission({ access, globalRole: session.globalRole });
  return {
    stage: pipeline?.stage ?? "EPOCHE",
    assumptions: assumptions.map((row) => ({ id: row.id, text: row.text, origin: row.origin, status: row.status })),
    proposals: proposals.map((row) => {
      const text = proposalText(row.kind, row.payload);
      return { id: row.id, kind: row.kind, status: row.status, text: text.text, excerpt: text.excerpt };
    }),
    synthesis: synthesis
      ? {
          version: synthesis.version,
          diagE: synthesis.diagE,
          diagP: synthesis.diagP,
          diagC: synthesis.diagC,
          sections: synthesis.sections as unknown as SynthesisDraft["sections"],
        }
      : null,
    canAuthor: permission.ok,
  };
}
