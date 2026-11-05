import { z } from "zod";
import type { GlobalRole, Prisma } from "../generated/prisma";
import { prisma } from "../lib/prisma";
import { caseReadAccess } from "./caseAccess";
import { aiGeneratedFieldsSchema, type ExplanationRecord, validateExplanationRecord } from "./explanationRecord";
import { HUMAN_AUTHORED_MIN_CITATIONS, HUMAN_AUTHORED_MODEL_ID, HUMAN_AUTHORED_PROMPT_VERSION } from "./humanAuthored";
import { type MutationOutcome, runMutation, StaleDraftError, type WriteResult } from "./mutate";
import { isFromStateAllowed, transitionsFor } from "./stateMachine";

/**
 * author_draft: the assigned case manager writes the recommendation draft.
 *
 * This is the path a program uses when no model is configured, or when it
 * chooses not to send case material to one. No model is called. The draft
 * is stored as a normal DRAFT version and still has to pass the separate
 * issue_recommendation checklist; nothing here issues it.
 *
 * Replacing an existing DRAFT keeps it as SUPERSEDED and requires a reason,
 * the same rule as a correction to a model draft.
 */

const MAX_TEXT = 8000;

export const authoredDraftFieldsSchema = aiGeneratedFieldsSchema.extend({
  proposed_outcome: aiGeneratedFieldsSchema.shape.proposed_outcome.refine(v => v.length <= MAX_TEXT, "proposed_outcome is too long"),
  reasoning: aiGeneratedFieldsSchema.shape.reasoning.refine(v => v.length <= MAX_TEXT, "reasoning is too long"),
  limits: z.array(z.string().trim().min(1).max(MAX_TEXT)).min(1, "limits must be non-empty").max(50),
  not_considered: z.array(z.string().trim().min(1).max(MAX_TEXT)).min(1, "not_considered must be non-empty").max(50),
  evidence_citations: z.array(z.object({
    evidence_item_id: z.string().uuid(),
    relevance: z.string().trim().min(1).max(2000),
  }).strict()).min(HUMAN_AUTHORED_MIN_CITATIONS, "cite at least one piece of clean evidence from this case").max(100)
    .refine(list => new Set(list.map(c => c.evidence_item_id)).size === list.length, "each evidence item can be cited once"),
}).strict();

export interface AuthorDraftInput {
  actorId: string;
  actorRole: GlobalRole;
  caseId: string;
  fields: unknown;
  /** Required only when this replaces an existing draft. */
  reason?: string;
  /** The draft the manager saw, if any. A mismatch is a stale write. */
  replacesRecommendationId?: string | null;
}

export async function authorDraft(input: AuthorDraftInput): Promise<MutationOutcome<WriteResult>> {
  const caseRow = await prisma.case.findUnique({ where: { id: input.caseId } });
  if (!caseRow) return { ok: false, step: "not-found", reason: "Case not found." };
  if (!caseReadAccess(caseRow, { userId: input.actorId, globalRole: input.actorRole })) return { ok: false, step: "not-found", reason: "Case not found." };
  // Role, assignment and state come first, so a party or another manager
  // never learns anything about the draft from a later check.
  if (input.actorRole !== "CASE_MANAGER") return { ok: false, step: "authorize-role", reason: "Role not permitted to perform author_draft." };
  if (caseRow.caseManagerId !== input.actorId) return { ok: false, step: "not-found", reason: "Case not found." };
  if (!isFromStateAllowed(transitionsFor("author_draft"), caseRow.state)) {
    return { ok: false, step: "authorize-state", reason: `Cannot author_draft from state ${caseRow.state}.` };
  }

  const prior = caseRow.currentRecommendationId
    ? await prisma.recommendation.findUnique({ where: { id: caseRow.currentRecommendationId } })
    : null;
  const expectedPriorId = input.replacesRecommendationId ?? null;
  if ((prior?.id ?? null) !== expectedPriorId) {
    return { ok: false, step: "guard", reason: "The draft changed. Reload before writing a new draft." };
  }
  if (prior && prior.status !== "DRAFT") {
    return { ok: false, step: "guard", reason: "Only a draft can be replaced." };
  }
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (prior && (!reason || reason.length > MAX_TEXT)) {
    return { ok: false, step: "guard", reason: "A reason is required to replace the current draft." };
  }

  const parsed = authoredDraftFieldsSchema.safeParse(input.fields);
  let schemaValidationError: string | null = parsed.success
    ? null
    : parsed.error.issues.map(issue => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");

  const explanation: ExplanationRecord | null = parsed.success
    ? {
        ...parsed.data,
        knowledge_sources: [],
        model: { id: HUMAN_AUTHORED_MODEL_ID, prompt_version: HUMAN_AUTHORED_PROMPT_VERSION },
        reviewer: { user_id: null, issued_at: null },
      }
    : null;
  if (explanation && !schemaValidationError) schemaValidationError = validateExplanationRecord(explanation);
  if (explanation && !schemaValidationError) {
    const clean = await prisma.evidenceItem.findMany({ where: { caseId: caseRow.id, scanStatus: "CLEAN" }, select: { id: true } });
    const cleanIds = new Set(clean.map(e => e.id));
    if (explanation.evidence_citations.some(c => !cleanIds.has(c.evidence_item_id))) {
      schemaValidationError = "Citation does not resolve to clean evidence in this case.";
    }
  }

  const [complainantPosition, respondentPosition, coiDeclaration] = await Promise.all([
    prisma.positionStatement.findFirst({ where: { caseId: caseRow.id, partyId: caseRow.complainantId } }),
    prisma.positionStatement.findFirst({ where: { caseId: caseRow.id, partyId: caseRow.respondentId } }),
    prisma.coiDeclaration.findFirst({ where: { caseId: caseRow.id, caseManagerId: input.actorId }, orderBy: { declaredAt: "desc" } }),
  ]);

  return runMutation({
    trigger: "author_draft",
    actorId: input.actorId,
    actorRole: input.actorRole,
    fromState: caseRow.state,
    guardContexts: {
      caseAssignedToManager: { actorId: input.actorId, caseManagerId: caseRow.caseManagerId },
      bothPartiesHaveCurrentPositions: {
        complainantHasPosition: complainantPosition !== null,
        respondentHasPosition: respondentPosition !== null,
      },
      coiDeclarationOnFile: { declared: coiDeclaration !== null, hasConflict: coiDeclaration?.hasConflict ?? false },
      explanationRecordValid: { schemaValidationError },
    },
    write: async (tx) => {
      if (!explanation) throw new Error("authorDraft: guard passed without a valid explanation.");
      // Same row lock as model drafting: one writer, and never while a model
      // request is still in flight.
      const locked = await tx.case.updateMany({
        where: {
          id: caseRow.id, state: caseRow.state, caseManagerId: input.actorId,
          currentRecommendationId: caseRow.currentRecommendationId,
          OR: [{ draftRequestId: null }, { draftRequestedAt: { lt: new Date(Date.now() - 15 * 60_000) } }],
        },
        data: { state: "DRAFTING", draftRequestId: null, draftRequestedAt: null },
      });
      if (locked.count !== 1) throw new StaleDraftError();
      const latest = await tx.recommendation.findFirst({ where: { caseId: caseRow.id }, orderBy: { version: "desc" }, select: { version: true } });
      const recommendation = await tx.recommendation.create({
        data: {
          caseId: caseRow.id,
          version: (latest?.version ?? 0) + 1,
          status: "DRAFT",
          explanation: explanation as unknown as Prisma.InputJsonValue,
          modelId: HUMAN_AUTHORED_MODEL_ID,
          promptVersion: HUMAN_AUTHORED_PROMPT_VERSION,
        },
      });
      if (prior) await tx.recommendation.update({ where: { id: prior.id }, data: { status: "SUPERSEDED" } });
      await tx.case.update({ where: { id: caseRow.id }, data: { currentRecommendationId: recommendation.id } });

      const eventPayloads: WriteResult["eventPayloads"] = [];
      if (caseRow.state === "POSITIONS") {
        eventPayloads.push({ type: "RECOMMENDATION_DRAFT_REQUESTED", payload: { origin: "case_manager_authored" } });
      }
      eventPayloads.push({
        type: "RECOMMENDATION_DRAFTED",
        payload: { recommendationId: recommendation.id, version: recommendation.version, origin: "case_manager_authored", ...(prior ? { supersedesId: prior.id } : {}) },
      });
      if (prior) {
        eventPayloads.push({ type: "NOTE_ADDED", payload: { kind: "authored_draft_replacement", recommendationId: recommendation.id, priorRecommendationId: prior.id, reason } });
      }
      return { caseId: caseRow.id, toState: "DRAFTING", eventPayloads };
    },
  });
}
