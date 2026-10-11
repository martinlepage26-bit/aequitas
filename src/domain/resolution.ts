import { z } from "zod";
import type { CaseState, ContestationStatus, ContestationTarget, GlobalRole, Prisma } from "../generated/prisma";
import { prisma } from "../lib/prisma";
import { caseReadAccess } from "./caseAccess";
import { appendEvent } from "./events";
import type { MutationOutcome } from "./mutate";

/**
 * Phase 3a/3b: contestation and approver sign-off (handoff §10 phase 3,
 * Air's plan 2026-10-11, DECISIONS.md "Phase 3").
 *
 * The resolve path in this app is give_consent: the consent that completes
 * both parties' GIVEN state moves the case to RESOLVED_CONSENT. Phase 3 puts
 * two guards in front of every give_consent:
 *   - OPEN_CONTESTATION: any contestation on the case is still OPEN.
 *   - APPROVAL_REQUIRED: the case is not consent-only (created after the
 *     phase 3 migration) and no approver has signed off on the current
 *     recommendation version.
 * Both come back as 409 with the code in the body.
 */

export const RESOLUTION_BLOCKERS = ["OPEN_CONTESTATION", "APPROVAL_REQUIRED"] as const;
export type ResolutionBlocker = (typeof RESOLUTION_BLOCKERS)[number];

export const APPROVAL_FAILURE_CODES = [
  "ADMIN_CANNOT_APPROVE",
  "NOT_APPROVER",
  "PARTY_CANNOT_APPROVE",
  "SAME_AUTHOR",
  "MISSING_RATIONALE",
  "OPEN_CONTESTATION",
  "NO_ISSUED_RECOMMENDATION",
  "ALREADY_APPROVED",
] as const;
export type ApprovalFailureCode = (typeof APPROVAL_FAILURE_CODES)[number];

export type CodedOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; step: "authorize-role" | "authorize-state" | "guard" | "not-found"; reason: string; code?: string };

export const CONTESTATION_TARGETS = ["CLAIM", "SYNTHESIS", "PROPOSAL", "RECOMMENDATION"] as const;

/** States in which a contestation can be opened, answered, or withdrawn. */
const CONTESTABLE_STATES: CaseState[] = ["OPEN", "EVIDENCE_INTAKE", "POSITIONS", "DRAFTING", "ISSUED"];

const text = (max: number) => z.string().trim().min(1).max(max);

export const openContestationSchema = z.object({
  targetType: z.enum(CONTESTATION_TARGETS),
  targetId: z.string().uuid(),
  grounds: text(4000),
});
export const respondContestationSchema = z.object({ response: text(4000) });
export const overruleContestationSchema = z.object({ reason: text(4000) });
export const approveResolutionSchema = z.object({ rationale: z.string().max(4000).optional().nullable() });

export interface ActorInput {
  actorId: string;
  actorRole: GlobalRole;
  caseId: string;
}

function fail(step: "authorize-role" | "authorize-state" | "guard" | "not-found", reason: string, code?: string): CodedOutcome<never> {
  return { ok: false, step, reason, ...(code ? { code } : {}) };
}

// --- pure rules (unit tested) ------------------------------------------

export interface BlockerInput {
  consentOnlyResolution: boolean;
  openContestations: number;
  approvedForCurrentRecommendation: boolean;
}

export function resolutionBlockers(input: BlockerInput): ResolutionBlocker[] {
  const blockers: ResolutionBlocker[] = [];
  if (input.openContestations > 0) blockers.push("OPEN_CONTESTATION");
  if (!input.consentOnlyResolution && !input.approvedForCurrentRecommendation) blockers.push("APPROVAL_REQUIRED");
  return blockers;
}

export const BLOCKER_REASONS: Record<ResolutionBlocker, string> = {
  OPEN_CONTESTATION: "A contestation on this case is still open. It must be answered, overruled, or withdrawn before the case can resolve.",
  APPROVAL_REQUIRED: "This case needs approver sign-off on the current recommendation before consent can resolve it.",
};

export interface ApprovalCheckInput {
  approver: { id: string; globalRole: GlobalRole; isApprover: boolean };
  caseRow: { complainantId: string; respondentId: string; caseManagerId: string | null; state: CaseState; currentRecommendationId: string | null };
  recommendationIssuedById: string | null;
  latestSynthesisAuthorId: string | null;
  rationale: string | null;
  openContestations: number;
  alreadyApproved: boolean;
}

/**
 * Separation of duties (handoff §4): no role can both author and approve.
 * Order matters for the code a caller sees: who you are first, then what
 * you authored, then the state of the case.
 */
export function checkApproval(input: ApprovalCheckInput): { ok: true } | { ok: false; status: 403 | 409; code: ApprovalFailureCode; reason: string } {
  const { approver, caseRow } = input;
  if (approver.globalRole === "ADMIN") {
    return { ok: false, status: 403, code: "ADMIN_CANNOT_APPROVE", reason: "Administrators cannot approve a resolution." };
  }
  if (approver.id === caseRow.complainantId || approver.id === caseRow.respondentId) {
    return { ok: false, status: 403, code: "PARTY_CANNOT_APPROVE", reason: "A party to the case cannot approve its resolution." };
  }
  const authors = new Set([caseRow.caseManagerId, input.recommendationIssuedById, input.latestSynthesisAuthorId].filter((id): id is string => Boolean(id)));
  if (authors.has(approver.id)) {
    return { ok: false, status: 409, code: "SAME_AUTHOR", reason: "The case manager who owns this case, or who authored its recommendation or synthesis, cannot also approve it." };
  }
  if (approver.globalRole !== "CASE_MANAGER" || !approver.isApprover) {
    return { ok: false, status: 403, code: "NOT_APPROVER", reason: "Only a designated approver can sign off on a resolution." };
  }
  if (caseRow.state !== "ISSUED" || !caseRow.currentRecommendationId) {
    return { ok: false, status: 409, code: "NO_ISSUED_RECOMMENDATION", reason: "Sign-off applies to an issued recommendation." };
  }
  if (!input.rationale) {
    return { ok: false, status: 409, code: "MISSING_RATIONALE", reason: "Sign-off needs a written rationale." };
  }
  if (input.openContestations > 0) {
    return { ok: false, status: 409, code: "OPEN_CONTESTATION", reason: BLOCKER_REASONS.OPEN_CONTESTATION };
  }
  if (input.alreadyApproved) {
    return { ok: false, status: 409, code: "ALREADY_APPROVED", reason: "This recommendation version already has approver sign-off." };
  }
  return { ok: true };
}

// --- reads ---------------------------------------------------------------

type Db = Prisma.TransactionClient | typeof prisma;

export async function loadResolutionBlockers(db: Db, caseId: string): Promise<ResolutionBlocker[]> {
  const caseRow = await db.case.findUnique({ where: { id: caseId }, select: { consentOnlyResolution: true, currentRecommendationId: true } });
  if (!caseRow) return [];
  const [openContestations, approvals] = await Promise.all([
    db.contestation.count({ where: { caseId, status: "OPEN" } }),
    caseRow.currentRecommendationId
      ? db.reviewTrail.count({ where: { caseId, action: "APPROVED", recommendationId: caseRow.currentRecommendationId } })
      : Promise.resolve(0),
  ]);
  return resolutionBlockers({
    consentOnlyResolution: caseRow.consentOnlyResolution,
    openContestations,
    approvedForCurrentRecommendation: approvals > 0,
  });
}

export interface ContestationView {
  id: string;
  targetType: ContestationTarget;
  targetId: string;
  grounds: string;
  status: ContestationStatus;
  openedById: string;
  openedByName: string;
  response: string | null;
  respondedByName: string | null;
  overruleReason: string | null;
  overruledByName: string | null;
  createdAt: string;
}

export interface ResolutionView {
  consentOnlyResolution: boolean;
  blockers: ResolutionBlocker[];
  approval: { approverName: string; rationale: string | null; createdAt: string } | null;
  contestations: ContestationView[];
  viewer: {
    canOpen: boolean;
    canRespond: boolean;
    canOverrule: boolean;
    canApprove: boolean;
    approveBlockedCode: ApprovalFailureCode | null;
  };
}

export async function readResolutionView(caseId: string, viewer: { userId: string; globalRole: GlobalRole; isApprover: boolean }): Promise<ResolutionView | null> {
  const caseRow = await prisma.case.findUnique({ where: { id: caseId } });
  if (!caseRow) return null;
  const [rows, approvalRow, recommendation, synthesis, blockers] = await Promise.all([
    prisma.contestation.findMany({
      where: { caseId },
      orderBy: { createdAt: "asc" },
      include: { openedBy: { select: { displayName: true } }, respondedBy: { select: { displayName: true } }, overruledBy: { select: { displayName: true } } },
    }),
    caseRow.currentRecommendationId
      ? prisma.reviewTrail.findFirst({
          where: { caseId, action: "APPROVED", recommendationId: caseRow.currentRecommendationId },
          include: { reviewer: { select: { displayName: true } } },
          orderBy: { createdAt: "desc" },
        })
      : Promise.resolve(null),
    caseRow.currentRecommendationId ? prisma.recommendation.findUnique({ where: { id: caseRow.currentRecommendationId }, select: { issuedById: true } }) : Promise.resolve(null),
    prisma.synthesisVersion.findFirst({ where: { caseId }, orderBy: { version: "desc" }, select: { createdById: true } }),
    loadResolutionBlockers(prisma, caseId),
  ]);
  const open = rows.filter((row) => row.status === "OPEN").length;
  const contestable = CONTESTABLE_STATES.includes(caseRow.state);
  const access = caseReadAccess(caseRow, viewer);
  const approvalCheck = checkApproval({
    approver: { id: viewer.userId, globalRole: viewer.globalRole, isApprover: viewer.isApprover },
    caseRow,
    recommendationIssuedById: recommendation?.issuedById ?? null,
    latestSynthesisAuthorId: synthesis?.createdById ?? null,
    rationale: "placeholder",
    openContestations: open,
    alreadyApproved: Boolean(approvalRow),
  });
  return {
    consentOnlyResolution: caseRow.consentOnlyResolution,
    blockers,
    approval: approvalRow ? { approverName: approvalRow.reviewer.displayName, rationale: approvalRow.rationale, createdAt: approvalRow.createdAt.toISOString() } : null,
    contestations: rows.map((row) => ({
      id: row.id,
      targetType: row.targetType,
      targetId: row.targetId,
      grounds: row.grounds,
      status: row.status,
      openedById: row.openedById,
      openedByName: row.openedBy.displayName,
      response: row.response,
      respondedByName: row.respondedBy?.displayName ?? null,
      overruleReason: row.overruleReason,
      overruledByName: row.overruledBy?.displayName ?? null,
      createdAt: row.createdAt.toISOString(),
    })),
    viewer: {
      canOpen: contestable && (access === "party" || access === "assigned-manager"),
      canRespond: contestable && access === "assigned-manager" && viewer.globalRole === "CASE_MANAGER",
      canOverrule: contestable && viewer.isApprover && viewer.globalRole === "CASE_MANAGER" && caseRow.caseManagerId !== viewer.userId && access !== "party",
      canApprove: approvalCheck.ok,
      approveBlockedCode: approvalCheck.ok || !viewer.isApprover ? null : approvalCheck.code,
    },
  };
}

// --- writes --------------------------------------------------------------

async function loadActor(actorId: string) {
  return prisma.user.findUnique({ where: { id: actorId }, select: { id: true, globalRole: true, isApprover: true } });
}

async function targetBelongsToCase(tx: Prisma.TransactionClient, caseId: string, targetType: ContestationTarget, targetId: string): Promise<boolean> {
  switch (targetType) {
    case "CLAIM":
      return (await tx.claim.count({ where: { id: targetId, caseId, deletedAt: null } })) > 0;
    case "SYNTHESIS":
      return (await tx.synthesisVersion.count({ where: { id: targetId, caseId } })) > 0;
    case "PROPOSAL":
      return (await tx.pipelineProposal.count({ where: { id: targetId, caseId } })) > 0;
    case "RECOMMENDATION":
      return (await tx.recommendation.count({ where: { id: targetId, caseId } })) > 0;
  }
}

class WriteGuardError extends Error {
  constructor(readonly outcome: CodedOutcome<never>) {
    super(outcome.ok ? "" : outcome.reason);
  }
}

async function lockCase(tx: Prisma.TransactionClient, caseId: string) {
  await tx.$queryRaw`SELECT id FROM "Case" WHERE id = ${caseId} FOR UPDATE`;
}

/** Parties (affected_party) and the assigned case manager (reviewer) may contest. */
export async function openContestation(input: ActorInput & z.infer<typeof openContestationSchema>): Promise<CodedOutcome<{ id: string }>> {
  const parsed = openContestationSchema.safeParse(input);
  if (!parsed.success) return fail("guard", "A contestation needs a target and written grounds.", "INVALID_INPUT");
  const caseRow = await prisma.case.findUnique({ where: { id: input.caseId } });
  if (!caseRow) return fail("not-found", "Case not found.");
  const access = caseReadAccess(caseRow, { userId: input.actorId, globalRole: input.actorRole });
  if (!access || access === "claimable") return fail("not-found", "Case not found.");
  if (access === "admin") return fail("authorize-role", "Administrators cannot open a contestation.");
  if (!CONTESTABLE_STATES.includes(caseRow.state)) return fail("authorize-state", `Cannot contest from state ${caseRow.state}.`, "CASE_NOT_CONTESTABLE");

  try {
    const id = await prisma.$transaction(async (tx) => {
      if (!(await targetBelongsToCase(tx, input.caseId, parsed.data.targetType, parsed.data.targetId))) {
        throw new WriteGuardError(fail("guard", "That item is not on this case.", "TARGET_NOT_ON_CASE"));
      }
      const row = await tx.contestation.create({
        data: { caseId: input.caseId, targetType: parsed.data.targetType, targetId: parsed.data.targetId, grounds: parsed.data.grounds, openedById: input.actorId },
      });
      await appendEvent(tx, {
        caseId: input.caseId,
        type: "CONTESTATION_OPENED",
        actorId: input.actorId,
        payload: { contestationId: row.id, targetType: row.targetType, targetId: row.targetId, grounds: row.grounds },
      });
      return row.id;
    });
    return { ok: true, data: { id } };
  } catch (error) {
    if (error instanceof WriteGuardError) return error.outcome;
    throw error;
  }
}

type ContestationAction = "respond" | "overrule" | "withdraw";

async function closeContestation(
  input: ActorInput & { contestationId: string },
  action: ContestationAction,
  note: string | null,
): Promise<CodedOutcome<{ id: string }>> {
  const caseRow = await prisma.case.findUnique({ where: { id: input.caseId } });
  if (!caseRow) return fail("not-found", "Case not found.");
  const actor = await loadActor(input.actorId);
  if (!actor) return fail("not-found", "Case not found.");
  const access = caseReadAccess(caseRow, { userId: input.actorId, globalRole: input.actorRole });

  if (action === "respond") {
    if (access !== "assigned-manager" || input.actorRole !== "CASE_MANAGER") {
      if (!access || access === "claimable") return fail("not-found", "Case not found.");
      return fail("authorize-role", "Only the case manager assigned to this case can respond to a contestation.");
    }
  } else if (action === "overrule") {
    if (input.actorRole === "ADMIN") return fail("authorize-role", "Administrators cannot overrule a contestation.", "ADMIN_CANNOT_APPROVE");
    if (access === "party") return fail("authorize-role", "A party cannot overrule a contestation.", "PARTY_CANNOT_APPROVE");
    if (input.actorRole !== "CASE_MANAGER" || !actor.isApprover) return fail("authorize-role", "Only a designated approver can overrule a contestation.", "NOT_APPROVER");
    if (caseRow.caseManagerId === input.actorId) {
      return fail("guard", "The case manager who owns this case cannot overrule a contestation on it.", "SAME_AUTHOR");
    }
  } else {
    if (!access || access === "claimable") return fail("not-found", "Case not found.");
  }
  if (!CONTESTABLE_STATES.includes(caseRow.state)) return fail("authorize-state", `Cannot change a contestation from state ${caseRow.state}.`, "CASE_NOT_CONTESTABLE");
  if ((action === "respond" || action === "overrule") && !note) {
    return fail("guard", action === "respond" ? "A response needs written text." : "An overrule needs a written reason.", "MISSING_RATIONALE");
  }

  try {
    const id = await prisma.$transaction(async (tx) => {
      await lockCase(tx, input.caseId);
      const row = await tx.contestation.findFirst({ where: { id: input.contestationId, caseId: input.caseId } });
      if (!row) throw new WriteGuardError(fail("not-found", "Contestation not found."));
      if (row.status !== "OPEN") throw new WriteGuardError(fail("guard", "This contestation is no longer open.", "CONTESTATION_NOT_OPEN"));
      if (action === "withdraw" && row.openedById !== input.actorId) {
        throw new WriteGuardError(fail("authorize-role", "Only the person who opened a contestation can withdraw it."));
      }
      const now = new Date();
      const data: Prisma.ContestationUpdateInput =
        action === "respond"
          ? { status: "RESPONDED", response: note, respondedBy: { connect: { id: input.actorId } }, respondedAt: now }
          : action === "overrule"
            ? { status: "OVERRULED", overruleReason: note, overruledBy: { connect: { id: input.actorId } }, overruledAt: now }
            : { status: "WITHDRAWN", withdrawnAt: now };
      await tx.contestation.update({ where: { id: row.id }, data });
      if (action === "overrule") {
        await tx.reviewTrail.create({
          data: {
            caseId: input.caseId,
            reviewerId: input.actorId,
            createdById: input.actorId,
            action: "OVERRULED_CONTESTATION",
            rationale: note,
            snapshot: { contestationId: row.id, targetType: row.targetType, targetId: row.targetId },
          },
        });
      }
      await appendEvent(tx, {
        caseId: input.caseId,
        type: action === "respond" ? "CONTESTATION_RESPONDED" : action === "overrule" ? "CONTESTATION_OVERRULED" : "CONTESTATION_WITHDRAWN",
        actorId: input.actorId,
        payload: { contestationId: row.id, ...(action === "respond" ? { response: note } : action === "overrule" ? { reason: note } : {}) },
      });
      return row.id;
    });
    return { ok: true, data: { id } };
  } catch (error) {
    if (error instanceof WriteGuardError) return error.outcome;
    throw error;
  }
}

function blankToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

export function respondToContestation(input: ActorInput & { contestationId: string; response?: string | null }) {
  return closeContestation(input, "respond", blankToNull(input.response));
}

export function overruleContestation(input: ActorInput & { contestationId: string; reason?: string | null }) {
  return closeContestation(input, "overrule", blankToNull(input.reason));
}

export function withdrawContestation(input: ActorInput & { contestationId: string }) {
  return closeContestation(input, "withdraw", null);
}

/** Approver sign-off on the current recommendation (ReviewTrail APPROVED). */
export async function approveResolution(input: ActorInput & { rationale?: string | null }): Promise<CodedOutcome<{ id: string }> & { status?: number }> {
  const caseRow = await prisma.case.findUnique({ where: { id: input.caseId } });
  if (!caseRow) return fail("not-found", "Case not found.");
  const actor = await loadActor(input.actorId);
  if (!actor) return fail("not-found", "Case not found.");
  const rationale = blankToNull(input.rationale);

  try {
    const id = await prisma.$transaction(async (tx) => {
      await lockCase(tx, input.caseId);
      const fresh = await tx.case.findUniqueOrThrow({ where: { id: input.caseId } });
      const [recommendation, synthesis, openContestations, approvals] = await Promise.all([
        fresh.currentRecommendationId ? tx.recommendation.findUnique({ where: { id: fresh.currentRecommendationId } }) : Promise.resolve(null),
        tx.synthesisVersion.findFirst({ where: { caseId: input.caseId }, orderBy: { version: "desc" }, select: { createdById: true } }),
        tx.contestation.count({ where: { caseId: input.caseId, status: "OPEN" } }),
        fresh.currentRecommendationId
          ? tx.reviewTrail.count({ where: { caseId: input.caseId, action: "APPROVED", recommendationId: fresh.currentRecommendationId } })
          : Promise.resolve(0),
      ]);
      const check = checkApproval({
        approver: { id: actor.id, globalRole: input.actorRole === "ADMIN" ? "ADMIN" : actor.globalRole, isApprover: actor.isApprover },
        caseRow: fresh,
        recommendationIssuedById: recommendation?.issuedById ?? null,
        latestSynthesisAuthorId: synthesis?.createdById ?? null,
        rationale,
        openContestations,
        alreadyApproved: approvals > 0,
      });
      if (!check.ok) {
        throw new WriteGuardError(fail(check.status === 403 ? "authorize-role" : "guard", check.reason, check.code));
      }
      const review = await tx.reviewTrail.create({
        data: {
          caseId: input.caseId,
          recommendationId: recommendation!.id,
          reviewerId: input.actorId,
          createdById: input.actorId,
          action: "APPROVED",
          rationale,
          snapshot: { recommendationId: recommendation!.id, version: recommendation!.version, issuedById: recommendation!.issuedById },
        },
      });
      await appendEvent(tx, {
        caseId: input.caseId,
        type: "RESOLUTION_APPROVED",
        actorId: input.actorId,
        payload: { reviewId: review.id, recommendationId: recommendation!.id, version: recommendation!.version, rationale },
      });
      return review.id;
    });
    return { ok: true, data: { id } };
  } catch (error) {
    if (error instanceof WriteGuardError) return error.outcome;
    throw error;
  }
}

/** Route-handler convenience: 403 for role failures, 404 not found, 409 otherwise; code in the body. */
export function codedFailureResponse(outcome: CodedOutcome<unknown>): Response | null {
  if (outcome.ok) return null;
  const status = outcome.step === "authorize-role" ? 403 : outcome.step === "not-found" ? 404 : 409;
  return Response.json({ message: outcome.reason, ...(outcome.code ? { code: outcome.code } : {}) }, { status });
}

export type { MutationOutcome };
