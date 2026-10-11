import { caseReadAccess } from "./caseAccess";
import { extractStoredEvidence, type EvidenceExtraction } from "../lib/evidenceText";
import { chronologyInputSchema } from "./chronology";
import { buildKnowledgeSources } from "../ai/prompts/conflictKnowledge";
import { validateConflictKnowledgeMap } from "./conflictKnowledge";
import { type DraftPromptInput } from "../ai/prompts/draftRecommendation";
import { routePromptContext } from "../ai/prompts/router";
import { fetchLegalResearch } from "../lib/legipro";
import { randomUUID } from "node:crypto";
import type { CaseState, ConsentState, DisputeCategory, EventType, EvidenceKind, GlobalRole, Prisma } from "../generated/prisma";
import { prisma } from "../lib/prisma";
import { scanBuffer, type ScanResult } from "../lib/scan";
import { CASE_AWAITING_MANAGER_KIND, deliverPendingNotifications } from "../lib/mail";
import { assertStoredIntake, missingIntakeFields } from "./intake";
import { rollbackBuffer, uploadEvidence } from "../lib/storage";
import { appendEvent } from "./events";
import { GUARD_REGISTRY } from "./guards";
import { coreAiGeneratedFieldsSchema, validateExplanationRecord, type ExplanationRecord } from "./explanationRecord";
import { draftRecommendation } from "../ai/draftRecommendation";
import { deriveGiveConsentState } from "./consent";
import { BLOCKER_REASONS, loadResolutionBlockers, type ResolutionBlocker } from "./resolution";
import {
  NONE,
  SYSTEM,
  isActorRoleAllowed,
  isFromStateAllowed,
  transitionsFor,
  type Trigger,
} from "./stateMachine";

/**
 * The one mutation pipeline — Section 4: "authenticate -> authorize (role +
 * case assignment) -> evaluate guard -> begin transaction -> write domain
 * rows -> append event(s) -> update projection -> commit -> enqueue
 * notifications. Implement as src/domain/mutate.ts so no endpoint can
 * accidentally skip a step."
 *
 * "Authenticate" is the caller's responsibility (session verification
 * happens before a mutation function is ever invoked — see M1's WebAuthn
 * work); this pipeline starts at "authorize" with an already-resolved actor.
 *
 * "Update projection" collapses into "write domain rows" for this schema:
 * Section 4 states domain tables ARE the materialized projection, and
 * Section 5 defines no separate projection table — Case.state is written
 * once, by `write()`, inside the same transaction as the event append.
 */

export type MutationOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; step: "authorize-role" | "authorize-state" | "guard" | "not-found"; reason: string; code?: string };

/**
 * Section 16: "RBAC failures return 404, not 403, for non-assigned cases" —
 * a guard failure here means the actor isn't a party to (or assigned
 * manager of) *this* case, which must read the same as the case not
 * existing at all, not as a generic business-rule conflict. Every other
 * guard (COI, evidence-count, version-sequencing, etc.) is a real 409:
 * the actor IS allowed to see this case, the action just isn't valid yet.
 */
const CASE_ACCESS_GUARDS = new Set([
  "isCaseOwner",
  "isCaseParty",
  "caseAssignedToManager",
  "caseAssignedToManagerOrUnclaimed",
  "supersedesOwnItem",
  "isConsentingParty",
]);

export interface NotificationSpec {
  userId: string;
  kind: string;
  locale: string;
}

export interface WriteResult {
  caseId: string;
  draftRequestId?: string;
  toState: CaseState;
  eventPayloads: Array<{ type: EventType; payload: unknown }>;
  notifications?: NotificationSpec[];
}

export interface RunMutationInput {
  trigger: Trigger;
  actorId: string;
  actorRole: GlobalRole | typeof SYSTEM;
  fromState: CaseState | typeof NONE;
  /** Guard name -> the exact context object that guard function expects. */
  guardContexts: Record<string, unknown>;
  write: (tx: Prisma.TransactionClient) => Promise<WriteResult>;
}

/**
 * ClamAV is a TCP connection this process reaches directly (src/lib/scan.ts) —
 * no honest "not configured" fallback exists there the way ANTHROPIC_API_KEY
 * does for AI drafting, so an unreachable scanner (e.g. no ClamAV sidecar
 * reachable from wherever this is deployed) would otherwise throw out of
 * submitEvidence/supersedeEvidence as an unhandled exception (a 500, not a
 * real MutationOutcome). Wrapping it here keeps Section 11's guarantee
 * intact — an unscanned item is never silently treated as CLEAN — while
 * still returning a real, documented failure instead of crashing.
 */
async function safeScan(buffer: Buffer): Promise<{ ok: true; scan: ScanResult } | { ok: false; outcome: MutationOutcome<WriteResult> }> {
  try {
    return { ok: true, scan: await scanBuffer(buffer) };
  } catch (error) {
    // The real error (e.g. a raw TCP connect failure) can embed the
    // scanner's internal host/port — never put it in a client-facing
    // response; log it server-side for diagnostics instead.
    console.error("Evidence scan failed:", error);
    return {
      ok: false,
      outcome: {
        ok: false,
        step: "guard",
        reason: "Evidence scanning is unavailable.",
      },
    };
  }
}

/** Route-handler convenience: turn a failed MutationOutcome into a Response. Returns null on success. */
export function mutationFailureResponse(outcome: MutationOutcome<WriteResult>): Response | null {
  if (outcome.ok) return null;
  const status = outcome.step === "authorize-role" ? 403 : outcome.step === "not-found" ? 404 : 409;
  return Response.json({ message: outcome.reason, ...(outcome.code ? { code: outcome.code } : {}) }, { status });
}

export async function runMutation(input: RunMutationInput): Promise<MutationOutcome<WriteResult>> {
  const def = transitionsFor(input.trigger);

  if (!isActorRoleAllowed(def, input.actorRole)) {
    return { ok: false, step: "authorize-role", reason: `Role not permitted to perform ${input.trigger}.` };
  }
  for (const guardName of def.guards.filter(name => CASE_ACCESS_GUARDS.has(name))) {
    const result = GUARD_REGISTRY[guardName](input.guardContexts[guardName]);
    if (!result.ok) return { ok: false, step: "not-found", reason: "Case not found." };
  }

  if (!isFromStateAllowed(def, input.fromState)) {
    return { ok: false, step: "authorize-state", reason: `Cannot ${input.trigger} from state ${input.fromState}.` };
  }

  for (const guardName of def.guards.filter(name => !CASE_ACCESS_GUARDS.has(name))) {
    const guardFn = GUARD_REGISTRY[guardName];
    if (!guardFn) throw new Error(`Guard "${guardName}" referenced by ${input.trigger} has no registered implementation.`);
    const result = guardFn(input.guardContexts[guardName]);
    if (!result.ok) {
      const step = CASE_ACCESS_GUARDS.has(guardName) ? "not-found" : "guard";
      return { ok: false, step, reason: result.reason, ...(result.code ? { code: result.code } : {}) };
    }
  }

  try {
    const data = await prisma.$transaction(async (tx) => {
      const writeResult = await input.write(tx);

      for (const event of writeResult.eventPayloads) {
        await appendEvent(tx, {
          caseId: writeResult.caseId,
          type: event.type,
          actorId: input.actorId,
          payload: event.payload,
        });
      }

      for (const notification of writeResult.notifications ?? []) {
        await tx.notification.create({
          data: {
            userId: notification.userId,
            caseId: writeResult.caseId,
            kind: notification.kind,
            locale: notification.locale,
          },
        });
      }

      return writeResult;
    });

    if (data.notifications?.length) {
      try { await deliverPendingNotifications(data.caseId); }
      catch { console.error("Notification dispatch unavailable; retained for retry."); }
    }
    return { ok: true, data };
  } catch (error) {
    if (error instanceof StaleSubmissionError) return { ok: false, step: "authorize-state", reason: "Evidence intake has closed. Reload the case before submitting." };
    if (error instanceof StaleDraftError) return { ok: false, step: "guard", reason: "The draft changed. Reload before reviewing or issuing it." };
    if (error instanceof ResolutionBlockedError) return { ok: false, step: "guard", reason: BLOCKER_REASONS[error.blocker], code: error.blocker };
    throw error;
  }
}

class StaleDraftError extends Error {}
class ResolutionBlockedError extends Error {
  constructor(readonly blocker: ResolutionBlocker) {
    super(blocker);
  }
}
class StaleSubmissionError extends Error {}

// --- create_case: the first concrete mutation built on the pipeline,
// used by M1's integration test to prove atomicity end to end. -----------

export interface CreateCaseInput {
  actorId: string;
  actorRole: GlobalRole;
  referenceNumber: string;
  complainantId: string;
  respondentId: string;
  /** Defaults to RETAIL, matching Case.category's schema default, when omitted. */
  category?: DisputeCategory;
  /** Required short account of the dispute, already trimmed. */
  disputeDescription: string;
  /** Optional approximate amount at stake, in Canadian cents. */
  amountAtStakeCents?: number | null;
  simulated: boolean;
  requestedStatementVersionId: string;
  currentStatementVersionId: string;
}

export async function createCase(input: CreateCaseInput): Promise<MutationOutcome<WriteResult>> {
  const intake = assertStoredIntake(input);
  if (!intake.ok) return { ok: false, step: "guard", reason: intake.reason };

  return runMutation({
    trigger: "create_case",
    actorId: input.actorId,
    actorRole: input.actorRole,
    fromState: NONE,
    guardContexts: {
      authenticated: { actorId: input.actorId },
      statementVersionsCurrent: {
        requestedVersionId: input.requestedStatementVersionId,
        currentVersionId: input.currentStatementVersionId,
      },
    },
    write: async (tx) => {
      const created = await tx.case.create({
        data: {
          referenceNumber: input.referenceNumber,
          state: "DRAFT",
          simulated: input.simulated,
          category: input.category ?? "RETAIL",
          disputeDescription: intake.description,
          amountAtStakeCents: intake.cents,
          complainantId: input.complainantId,
          respondentId: input.respondentId,
        },
      });
      return {
        caseId: created.id,
        toState: "DRAFT",
        eventPayloads: [
          {
            type: "CASE_CREATED",
            payload: {
              referenceNumber: created.referenceNumber,
              simulated: created.simulated,
              category: created.category,
              disputeDescription: created.disputeDescription,
              amountAtStakeCents: created.amountAtStakeCents,
            },
          },
        ],
      };
    },
  });
}

// --- submit_case: DRAFT -> OPEN --------------------------------------

export interface SubmitCaseInput {
  actorId: string;
  actorRole: GlobalRole;
  caseId: string;
}

export async function submitCase(input: SubmitCaseInput): Promise<MutationOutcome<WriteResult>> {
  const caseRow = await prisma.case.findUnique({
    where: { id: input.caseId },
    include: { respondent: { select: { locale: true } } },
  });
  if (!caseRow) return { ok: false, step: "not-found", reason: "Case not found." };
  if (!caseReadAccess(caseRow, { userId: input.actorId, globalRole: input.actorRole })) return { ok: false, step: "not-found", reason: "Case not found." };

  return runMutation({
    trigger: "submit_case",
    actorId: input.actorId,
    actorRole: input.actorRole,
    fromState: caseRow.state,
    guardContexts: {
      isCaseOwner: { actorId: input.actorId, complainantId: caseRow.complainantId },
      requiredIntakeFieldsComplete: { missingFields: missingIntakeFields(caseRow) },
    },
    write: async (tx) => {
      // Activated means a passkey is on the account. Inactive managers are
      // not queued: a pending row for someone who cannot sign in would sit
      // in the outbox forever.
      const managers = await tx.user.findMany({
        where: { globalRole: "CASE_MANAGER", credentials: { some: {} } },
        select: { id: true, locale: true },
      });
      await tx.case.update({ where: { id: input.caseId }, data: { state: "OPEN" } });
      return {
        caseId: input.caseId,
        toState: "OPEN",
        eventPayloads: [{ type: "CASE_SUBMITTED", payload: {} }],
        notifications: [
          { userId: caseRow.respondentId, kind: "case_submitted", locale: caseRow.respondent.locale },
          ...managers.map((manager) => ({ userId: manager.id, kind: CASE_AWAITING_MANAGER_KIND, locale: manager.locale })),
        ],
      };
    },
  });
}

// --- open_intake: OPEN -> EVIDENCE_INTAKE (self-claim; see DECISIONS.md) --

export interface OpenIntakeInput {
  actorId: string;
  actorRole: GlobalRole;
  caseId: string;
  hasConflict: boolean;
  coiDetails?: string;
}

export async function openIntake(input: OpenIntakeInput): Promise<MutationOutcome<WriteResult>> {
  const caseRow = await prisma.case.findUnique({ where: { id: input.caseId } });
  if (!caseRow) return { ok: false, step: "not-found", reason: "Case not found." };
  if (!caseReadAccess(caseRow, { userId: input.actorId, globalRole: input.actorRole })) return { ok: false, step: "not-found", reason: "Case not found." };

  return runMutation({
    trigger: "open_intake",
    actorId: input.actorId,
    actorRole: input.actorRole,
    fromState: caseRow.state,
    guardContexts: {
      caseAssignedToManagerOrUnclaimed: { actorId: input.actorId, caseManagerId: caseRow.caseManagerId },
      coiDeclarationOnFile: { declared: true, hasConflict: input.hasConflict },
    },
    write: async (tx) => {
      await tx.case.update({
        where: { id: input.caseId },
        data: { state: "EVIDENCE_INTAKE", caseManagerId: caseRow.caseManagerId ?? input.actorId },
      });
      await tx.coiDeclaration.create({
        data: {
          caseId: input.caseId,
          caseManagerId: input.actorId,
          hasConflict: input.hasConflict,
          details: input.coiDetails,
        },
      });
      return {
        caseId: input.caseId,
        toState: "EVIDENCE_INTAKE",
        eventPayloads: [
          { type: "EVIDENCE_INTAKE_OPENED", payload: {} },
          { type: "CASE_ASSIGNED", payload: { caseManagerId: input.actorId } },
        ],
      };
    },
  });
}

// --- submit_evidence / supersede_evidence: self-loop on EVIDENCE_INTAKE --
//
// Scan before uploading; failed domain writes delete the newly created object.

async function withStoredEvidence(storageKey: string, write: () => Promise<MutationOutcome<WriteResult>>) {
  let committed = false;
  try {
    const result = await write();
    committed = result.ok;
    return result;
  } finally {
    if (!committed) await rollbackBuffer(storageKey);
  }
}

interface EvidenceFields {
  kind: EvidenceKind;
  title: string;
  description?: string;
  buffer: Buffer;
  mimeType: string;
}

export interface SubmitEvidenceInput extends EvidenceFields {
  actorId: string;
  actorRole: GlobalRole;
  caseId: string;
}

export async function submitEvidence(input: SubmitEvidenceInput): Promise<MutationOutcome<WriteResult>> {
  if (input.actorRole !== "COMPLAINANT" && input.actorRole !== "RESPONDENT") {
    return { ok: false, step: "authorize-role", reason: "Only case parties may submit evidence." };
  }
  const caseRow = await prisma.case.findUnique({ where: { id: input.caseId } });
  if (!caseRow) return { ok: false, step: "not-found", reason: "Case not found." };
  if (!caseReadAccess(caseRow, { userId: input.actorId, globalRole: input.actorRole })) return { ok: false, step: "not-found", reason: "Case not found." };
  if (input.actorId !== caseRow.complainantId && input.actorId !== caseRow.respondentId) {
    return { ok: false, step: "not-found", reason: "Case not found." };
  }
  if (caseRow.state !== "EVIDENCE_INTAKE") return { ok: false, step: "authorize-state", reason: "Evidence intake is not open." };
  const actor = await prisma.user.findUnique({ where: { id: input.actorId }, select: { locale: true } });

  const scanAttempt = await safeScan(input.buffer);
  if (!scanAttempt.ok) return scanAttempt.outcome;
  const scan = scanAttempt.scan;

  const evidenceId = randomUUID();
  const upload = await uploadEvidence({
    caseId: input.caseId,
    evidenceId,
    simulated: caseRow.simulated,
    buffer: input.buffer,
    mimeType: input.mimeType,
  });

  return withStoredEvidence(upload.storageKey, () => runMutation({
    trigger: "submit_evidence",
    actorId: input.actorId,
    actorRole: input.actorRole,
    fromState: caseRow.state,
    guardContexts: {
      isCaseParty: { actorId: input.actorId, complainantId: caseRow.complainantId, respondentId: caseRow.respondentId },
      evidenceVisibilityRequiresCleanScan: {},
    },
    write: async (tx) => {
      const locked = await tx.case.updateMany({ where: { id: input.caseId, state: "EVIDENCE_INTAKE" }, data: { state: "EVIDENCE_INTAKE" } });
      if (locked.count !== 1) throw new StaleSubmissionError();
      const item = await tx.evidenceItem.create({
        data: {
          id: evidenceId,
          caseId: input.caseId,
          submittedById: input.actorId,
          kind: input.kind,
          title: input.title,
          description: input.description,
          storageKey: upload.storageKey,
          sha256: upload.sha256,
          byteSize: upload.byteSize,
          mimeType: input.mimeType,
          scanStatus: scan.clean ? "CLEAN" : "REJECTED",
          simulated: caseRow.simulated,
        },
      });
      return {
        caseId: input.caseId,
        toState: caseRow.state,
        eventPayloads: [
          {
            type: "EVIDENCE_SUBMITTED",
            payload: { evidenceItemId: item.id, kind: item.kind, scanStatus: item.scanStatus, signature: scan.signature },
          },
        ],
        notifications: scan.clean
          ? []
          : [{ userId: input.actorId, kind: "evidence_rejected", locale: actor?.locale ?? "fr-CA" }],
      };
    },
  }));
}

export interface SupersedeEvidenceInput extends EvidenceFields {
  actorId: string;
  actorRole: GlobalRole;
  caseId: string;
  priorEvidenceItemId: string;
}

export async function supersedeEvidence(input: SupersedeEvidenceInput): Promise<MutationOutcome<WriteResult>> {
  if (input.actorRole !== "COMPLAINANT" && input.actorRole !== "RESPONDENT") {
    return { ok: false, step: "authorize-role", reason: "Only case parties may submit evidence." };
  }
  const caseRow = await prisma.case.findUnique({ where: { id: input.caseId } });
  if (!caseRow) return { ok: false, step: "not-found", reason: "Case not found." };
  if (!caseReadAccess(caseRow, { userId: input.actorId, globalRole: input.actorRole })) return { ok: false, step: "not-found", reason: "Case not found." };

  const priorItem = await prisma.evidenceItem.findUnique({ where: { id: input.priorEvidenceItemId } });
  if (!priorItem || priorItem.caseId !== input.caseId) {
    return { ok: false, step: "not-found", reason: "Prior evidence item not found in this case." };
  }
  if (input.actorId !== caseRow.complainantId && input.actorId !== caseRow.respondentId) {
    return { ok: false, step: "not-found", reason: "Case not found." };
  }
  if (caseRow.state !== "EVIDENCE_INTAKE") return { ok: false, step: "authorize-state", reason: "Evidence intake is not open." };
  if (priorItem.submittedById !== input.actorId) return { ok: false, step: "not-found", reason: "Prior evidence item not found." };
  const actor = await prisma.user.findUnique({ where: { id: input.actorId }, select: { locale: true } });

  const scanAttempt = await safeScan(input.buffer);
  if (!scanAttempt.ok) return scanAttempt.outcome;
  const scan = scanAttempt.scan;

  const evidenceId = randomUUID();
  const upload = await uploadEvidence({
    caseId: input.caseId,
    evidenceId,
    simulated: caseRow.simulated,
    buffer: input.buffer,
    mimeType: input.mimeType,
  });

  return withStoredEvidence(upload.storageKey, () => runMutation({
    trigger: "supersede_evidence",
    actorId: input.actorId,
    actorRole: input.actorRole,
    fromState: caseRow.state,
    guardContexts: {
      isCaseParty: { actorId: input.actorId, complainantId: caseRow.complainantId, respondentId: caseRow.respondentId },
      supersedesOwnItem: { actorId: input.actorId, priorItemSubmittedById: priorItem.submittedById },
    },
    write: async (tx) => {
      const locked = await tx.case.updateMany({ where: { id: input.caseId, state: "EVIDENCE_INTAKE" }, data: { state: "EVIDENCE_INTAKE" } });
      if (locked.count !== 1) throw new StaleSubmissionError();
      const item = await tx.evidenceItem.create({
        data: {
          id: evidenceId,
          caseId: input.caseId,
          submittedById: input.actorId,
          kind: input.kind,
          title: input.title,
          description: input.description,
          storageKey: upload.storageKey,
          sha256: upload.sha256,
          byteSize: upload.byteSize,
          mimeType: input.mimeType,
          scanStatus: scan.clean ? "CLEAN" : "REJECTED",
          simulated: caseRow.simulated,
          version: priorItem.version + 1,
          supersedesId: priorItem.id,
        },
      });
      return {
        caseId: input.caseId,
        toState: caseRow.state,
        eventPayloads: [
          { type: "EVIDENCE_SUPERSEDED", payload: { newEvidenceItemId: item.id, priorEvidenceItemId: priorItem.id } },
        ],
        notifications: scan.clean
          ? []
          : [{ userId: input.actorId, kind: "evidence_rejected", locale: actor?.locale ?? "fr-CA" }],
      };
    },
  }));
}

export interface SubmitChronologyInput {
  actorId: string;
  actorRole: GlobalRole;
  caseId: string;
  occurredOn: string;
  title: string;
  description: string;
  locale: string;
}

export async function submitChronology(input: SubmitChronologyInput): Promise<MutationOutcome<WriteResult>> {
  if (input.actorRole !== "COMPLAINANT" && input.actorRole !== "RESPONDENT") {
    return { ok: false, step: "authorize-role", reason: "Only case parties may submit chronology entries." };
  }
  const caseRow = await prisma.case.findUnique({ where: { id: input.caseId } });
  if (!caseRow || (input.actorId !== caseRow.complainantId && input.actorId !== caseRow.respondentId)) {
    return { ok: false, step: "not-found", reason: "Case not found." };
  }
  const parsed = chronologyInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, step: "guard", reason: "A valid date, title, description and locale are required." };
  return runMutation({
    trigger: "submit_chronology", actorId: input.actorId, actorRole: input.actorRole, fromState: caseRow.state,
    guardContexts: { isCaseParty: { actorId: input.actorId, complainantId: caseRow.complainantId, respondentId: caseRow.respondentId } },
    write: async (tx) => {
      // Serialize submissions and reject a manager closing intake after the
      // precheck. Holding the case row lock also serializes the event chain.
      const locked = await tx.case.updateMany({ where: { id: input.caseId, state: "EVIDENCE_INTAKE" }, data: { state: "EVIDENCE_INTAKE" } });
      if (locked.count !== 1) throw new StaleSubmissionError();
      const entry = await tx.chronologyEntry.create({ data: {
        caseId: input.caseId, submittedById: input.actorId, ...parsed.data,
        occurredOn: new Date(`${parsed.data.occurredOn}T00:00:00.000Z`),
      } });
      return { caseId: input.caseId, toState: "EVIDENCE_INTAKE", eventPayloads: [{
        type: "CHRONOLOGY_ENTRY_SUBMITTED",
        payload: { chronologyEntryId: entry.id, ...parsed.data },
      }] };
    },
  });
}

// --- close_intake: EVIDENCE_INTAKE -> POSITIONS ---------------------------

export interface CloseIntakeInput {
  actorId: string;
  actorRole: GlobalRole;
  caseId: string;
  overrideReason?: string;
}

export async function closeIntake(input: CloseIntakeInput): Promise<MutationOutcome<WriteResult>> {
  const caseRow = await prisma.case.findUnique({ where: { id: input.caseId } });
  if (!caseRow) return { ok: false, step: "not-found", reason: "Case not found." };
  if (!caseReadAccess(caseRow, { userId: input.actorId, globalRole: input.actorRole })) return { ok: false, step: "not-found", reason: "Case not found." };

  // "Has evidence" only counts CLEAN items — Section 11: nothing PENDING or
  // REJECTED is ever visible to the other party or usable by the AI, so a
  // REJECTED-only submission shouldn't satisfy this guard either. Our scan
  // pipeline never actually leaves an item PENDING (scanBuffer runs before
  // the write), so in practice this is CLEAN vs REJECTED. See DECISIONS.md.
  const cleanItems = await prisma.evidenceItem.findMany({
    where: { caseId: input.caseId, scanStatus: "CLEAN" },
    select: { submittedById: true },
  });
  const complainantHasEvidence = cleanItems.some((e) => e.submittedById === caseRow.complainantId);
  const respondentHasEvidence = cleanItems.some((e) => e.submittedById === caseRow.respondentId);

  return runMutation({
    trigger: "close_intake",
    actorId: input.actorId,
    actorRole: input.actorRole,
    fromState: caseRow.state,
    guardContexts: {
      caseAssignedToManager: { actorId: input.actorId, caseManagerId: caseRow.caseManagerId },
      atLeastOneEvidenceItemPerPartyOrOverride: {
        complainantHasEvidence,
        respondentHasEvidence,
        overrideReason: input.overrideReason,
      },
    },
    write: async (tx) => {
      await tx.case.update({ where: { id: input.caseId }, data: { state: "POSITIONS" } });
      return {
        caseId: input.caseId,
        toState: "POSITIONS",
        eventPayloads: [{ type: "EVIDENCE_INTAKE_CLOSED", payload: { overrideReason: input.overrideReason ?? null } }],
      };
    },
  });
}

// --- submit_position: POSITIONS -> POSITIONS (self-loop, versioned) ------

export interface SubmitPositionInput {
  actorId: string;
  actorRole: GlobalRole;
  caseId: string;
  body: string;
  locale: string;
}

export async function submitPosition(input: SubmitPositionInput): Promise<MutationOutcome<WriteResult>> {
  const caseRow = await prisma.case.findUnique({ where: { id: input.caseId } });
  if (!caseRow) return { ok: false, step: "not-found", reason: "Case not found." };
  if (!caseReadAccess(caseRow, { userId: input.actorId, globalRole: input.actorRole })) return { ok: false, step: "not-found", reason: "Case not found." };

  const priorMax = await prisma.positionStatement.aggregate({
    where: { caseId: input.caseId, partyId: input.actorId },
    _max: { version: true },
  });
  const nextVersion = (priorMax._max.version ?? 0) + 1;

  return runMutation({
    trigger: "submit_position",
    actorId: input.actorId,
    actorRole: input.actorRole,
    fromState: caseRow.state,
    guardContexts: {
      isCaseParty: { actorId: input.actorId, complainantId: caseRow.complainantId, respondentId: caseRow.respondentId },
      oneCurrentVersionPerParty: {},
    },
    write: async (tx) => {
      const position = await tx.positionStatement.create({
        data: {
          caseId: input.caseId,
          partyId: input.actorId,
          body: input.body,
          locale: input.locale,
          version: nextVersion,
        },
      });
      return {
        caseId: input.caseId,
        toState: caseRow.state,
        eventPayloads: [{ type: "POSITION_SUBMITTED", payload: { positionId: position.id, version: position.version } }],
      };
    },
  });
}

// --- request_draft: POSITIONS -> DRAFTING ---------------------------------

export interface RequestDraftInput {
  actorId: string;
  actorRole: GlobalRole;
  caseId: string;
}

export async function requestDraft(input: RequestDraftInput): Promise<MutationOutcome<WriteResult>> {
  const caseRow = await prisma.case.findUnique({ where: { id: input.caseId } });
  if (!caseRow) return { ok: false, step: "not-found", reason: "Case not found." };
  if (!caseReadAccess(caseRow, { userId: input.actorId, globalRole: input.actorRole })) return { ok: false, step: "not-found", reason: "Case not found." };

  const [complainantPosition, respondentPosition, coiDeclaration] = await Promise.all([
    prisma.positionStatement.findFirst({ where: { caseId: input.caseId, partyId: caseRow.complainantId } }),
    prisma.positionStatement.findFirst({ where: { caseId: input.caseId, partyId: caseRow.respondentId } }),
    // Section 6's own guard is "COI declaration on file" — read back the
    // record open_intake already wrote for this manager, not request input.
    // See DECISIONS.md's M2 note on this same pattern.
    prisma.coiDeclaration.findFirst({ where: { caseId: input.caseId, caseManagerId: input.actorId }, orderBy: { declaredAt: "desc" } }),
  ]);

  const draftRequestId = randomUUID();
  return runMutation({
    trigger: "request_draft",
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
    },
    write: async (tx) => {
      const locked = await tx.case.updateMany({ where: { id: input.caseId, state: caseRow.state, caseManagerId: input.actorId, draftRequestId: caseRow.draftRequestId, OR: [{ draftRequestId: null }, { draftRequestedAt: { lt: new Date(Date.now() - 15 * 60_000) } }] }, data: { state: "DRAFTING", draftRequestId, draftRequestedAt: new Date() } });
      if (locked.count !== 1) throw new StaleDraftError();
      return {
        caseId: input.caseId,
        toState: "DRAFTING",
        draftRequestId,
        eventPayloads: [{ type: "RECOMMENDATION_DRAFT_REQUESTED", payload: { draftRequestId } }],
      };
    },
  });
}

// --- draft_completed: DRAFTING -> DRAFTING (SYSTEM actor) -----------------
//
// Section 9's pipeline step that actually calls Claude. Not reachable via
// any HTTP route with a real session (SYSTEM is not a session role) — the
// draft-requests API route calls requestDraft() then completeDraft() in
// the same request, synchronously, since this build has no background job
// queue. See DECISIONS.md's M3 note on why this is chained rather than
// deferred to a worker.

const SYSTEM_ACTOR_ID = "system";

export interface CompleteDraftInput {
  caseId: string;
  draftRequestId?: string;
}

export async function completeDraft(input: CompleteDraftInput): Promise<MutationOutcome<WriteResult>> {
  const row = await prisma.case.findUnique({ where: { id: input.caseId } });
  if (!row) return { ok: false, step: "not-found", reason: "Case not found." };
  const draftRequestId = input.draftRequestId ?? row.draftRequestId ?? undefined;
  if (input.draftRequestId && input.draftRequestId !== row.draftRequestId) return { ok: false, step: "guard", reason: "Draft request changed." };
  let outcome: MutationOutcome<WriteResult>;
  try { outcome = await buildDraft({ ...input, draftRequestId }); }
  catch { outcome = { ok: false, step: "guard", reason: "Draft generation is unavailable. Please try again." }; }
  if (!outcome.ok && row.state === "DRAFTING") {
    try { await prisma.$transaction(async tx => {
      const toState = row.currentRecommendationId ? "DRAFTING" : "POSITIONS";
      const recovered = await tx.case.updateMany({ where: { id: row.id, state: "DRAFTING", draftRequestId: draftRequestId ?? null, currentRecommendationId: row.currentRecommendationId }, data: { state: toState, draftRequestId: null, draftRequestedAt: null } });
      if (recovered.count === 1) await appendEvent(tx, { caseId: row.id, type: "RECOMMENDATION_DRAFT_FAILED", actorId: SYSTEM_ACTOR_ID, payload: { draftRequestId: draftRequestId ?? null, toState, reason: "draft_unavailable" } });
    }); } catch { console.error("Draft recovery could not be persisted; retained for retry.", { caseId: row.id }); }
  }
  return outcome;
}

async function buildDraft(input: CompleteDraftInput): Promise<MutationOutcome<WriteResult>> {
  const caseRow = await prisma.case.findUnique({
    where: { id: input.caseId },
    include: { complainant: { select: { locale: true } } },
  });
  if (!caseRow) return { ok: false, step: "not-found", reason: "Case not found." };

  const evidenceItems = await prisma.evidenceItem.findMany({
    where: { caseId: input.caseId, scanStatus: "CLEAN" },
  });
  const extractions = new Map<string, EvidenceExtraction>();
  if (process.env.ANTHROPIC_API_KEY) {
    let remaining = 60000;
    for (const item of evidenceItems) {
      if (remaining <= 0 || extractions.size >= 12) {
        extractions.set(item.id, { status: "bounded", method: "none", text: "", note: "Case extraction budget reached; this source is metadata only." });
        continue;
      }
      try {
        const extraction = await extractStoredEvidence(item);
        if (extraction.text.length > remaining) {
          extraction.text = extraction.text.slice(0, remaining);
          extraction.status = "bounded";
          extraction.note = "Case extraction budget reached; only a partial extract is available.";
        }
        remaining -= extraction.text.length;
        extractions.set(item.id, extraction);
      } catch {
        return { ok: false, step: "guard", reason: "Evidence could not be retrieved and verified. Check the original file before drafting." };
      }
    }
  }
  const complainantEvidence = evidenceItems
    .filter((e) => e.submittedById === caseRow.complainantId)
    .map((e) => ({ id: e.id, kind: e.kind, title: e.title, description: e.description, extraction: extractions.get(e.id), version: e.version, sha256: e.sha256, createdAt: e.createdAt.toISOString(), submittedByRole: "complainant" as const }));
  const respondentEvidence = evidenceItems
    .filter((e) => e.submittedById === caseRow.respondentId)
    .map((e) => ({ id: e.id, kind: e.kind, title: e.title, description: e.description, extraction: extractions.get(e.id), version: e.version, sha256: e.sha256, createdAt: e.createdAt.toISOString(), submittedByRole: "respondent" as const }));

  const [complainantPositionRow, respondentPositionRow] = await Promise.all([
    prisma.positionStatement.findFirst({ where: { caseId: input.caseId, partyId: caseRow.complainantId }, orderBy: { version: "desc" } }),
    prisma.positionStatement.findFirst({ where: { caseId: input.caseId, partyId: caseRow.respondentId }, orderBy: { version: "desc" } }),
  ]);

  const chronologyRows = await prisma.chronologyEntry.findMany({
    where: { caseId: input.caseId }, orderBy: [{ occurredOn: "asc" }, { createdAt: "asc" }, { id: "asc" }],
  });

  let promptInput: DraftPromptInput | undefined;
  let draftResult: Awaited<ReturnType<typeof draftRecommendation>>;
  if (!complainantPositionRow || !respondentPositionRow) {
    draftResult = { ok: false, reason: "Both parties must have a current position before a draft can be completed." };
  } else {
    // Fetched exactly once, here — see the comment on DraftPromptInput.legalResearch
    // for why this must never happen inside buildKnowledgeSources itself.
    const domainLabel = routePromptContext(caseRow.category).domainLabel;
    const legalResearch = await fetchLegalResearch(`Québec, Canada law applicable to a ${domainLabel}: rights, obligations, and remedies`);
    promptInput = {
      locale: caseRow.complainant.locale,
      category: caseRow.category,
      complainantEvidence,
      respondentEvidence,
      complainantPosition: { partyRole: "complainant", body: complainantPositionRow.body, id: complainantPositionRow.id, version: complainantPositionRow.version, locale: complainantPositionRow.locale, createdAt: complainantPositionRow.createdAt.toISOString() },
      respondentPosition: { partyRole: "respondent", body: respondentPositionRow.body, id: respondentPositionRow.id, version: respondentPositionRow.version, locale: respondentPositionRow.locale, createdAt: respondentPositionRow.createdAt.toISOString() },
      legalResearch,
      chronology: chronologyRows.map(entry => ({
        id: entry.id, occurredOn: entry.occurredOn.toISOString().slice(0, 10), title: entry.title,
        description: entry.description, locale: entry.locale, createdAt: entry.createdAt.toISOString(),
        submittedByRole: entry.submittedById === caseRow.complainantId ? "complainant" as const : "respondent" as const,
      })),
    };
    draftResult = await draftRecommendation(promptInput);
  }

  let schemaValidationError = draftResult.ok ? validateExplanationRecord(draftResult.explanation) : draftResult.reason;
  if (draftResult.ok && promptInput && !schemaValidationError) {
    const sources = buildKnowledgeSources(promptInput);
    schemaValidationError = validateConflictKnowledgeMap(draftResult.explanation.conflict_knowledge, sources);
    // Registry provenance comes from our database, never from AI output.
    draftResult.explanation.knowledge_sources = sources;
    if (draftResult.explanation.evidence_citations.some(c => !evidenceItems.some(e => e.id === c.evidence_item_id))) {
      schemaValidationError = "Citation does not resolve to clean evidence in this case.";
    }
  }

  return runMutation({
    trigger: "draft_completed",
    actorId: SYSTEM_ACTOR_ID,
    actorRole: SYSTEM,
    fromState: caseRow.state,
    guardContexts: {
      explanationRecordValidatesAgainstSchema: { schemaValidationError },
    },
    write: async (tx) => {
      if (!draftResult.ok) {
        // The guard above already rejected this path (schemaValidationError
        // would be non-null) whenever draftResult.ok is false — unreachable
        // in practice, kept only so TypeScript can narrow draftResult below.
        throw new Error("draftRecommendation failed after the schema guard passed — this should be unreachable.");
      }
      const locked = await tx.case.updateMany({
        where: { id: input.caseId, state: "DRAFTING", currentRecommendationId: caseRow.currentRecommendationId, draftRequestId: input.draftRequestId ?? null },
        data: { state: "DRAFTING", draftRequestId: null, draftRequestedAt: null },
      });
      if (locked.count !== 1) throw new StaleDraftError();
      // Section 6 row 14 (request_new_version): a redraft after a decline or
      // revocation is a NEW version, not a second version-1 row — the prior
      // recommendation was already marked SUPERSEDED by requestNewVersion(),
      // so counting existing rows for this case gives the right next number
      // whether this is the case's first draft ever or its Nth redraft.
      const priorCount = await tx.recommendation.count({ where: { caseId: input.caseId } });
      const recommendation = await tx.recommendation.create({
        data: {
          caseId: input.caseId,
          version: priorCount + 1,
          status: "DRAFT",
          explanation: draftResult.explanation as unknown as Prisma.InputJsonValue,
          modelId: draftResult.explanation.model.id,
          promptVersion: draftResult.explanation.model.prompt_version,
        },
      });
      if (caseRow.currentRecommendationId) {
        await tx.recommendation.updateMany({ where: { id: caseRow.currentRecommendationId, status: "DRAFT" }, data: { status: "SUPERSEDED" } });
      }
      await tx.case.update({ where: { id: input.caseId }, data: { currentRecommendationId: recommendation.id } });
      return {
        caseId: input.caseId,
        toState: "DRAFTING",
        eventPayloads: [
          { type: "RECOMMENDATION_DRAFTED", payload: { recommendationId: recommendation.id, version: recommendation.version } },
        ],
      };
    },
  });
}

// --- issue_recommendation: DRAFTING -> ISSUED -----------------------------

export interface IssueRecommendationInput {
  actorId: string;
  actorRole: GlobalRole;
  caseId: string;
}

export async function issueRecommendation(input: IssueRecommendationInput): Promise<MutationOutcome<WriteResult>> {
  const caseRow = await prisma.case.findUnique({
    where: { id: input.caseId },
    include: { complainant: { select: { locale: true } }, respondent: { select: { locale: true } } },
  });
  if (!caseRow) return { ok: false, step: "not-found", reason: "Case not found." };
  if (!caseReadAccess(caseRow, { userId: input.actorId, globalRole: input.actorRole })) return { ok: false, step: "not-found", reason: "Case not found." };

  if (!caseRow.currentRecommendationId) {
    return { ok: false, step: "not-found", reason: "No draft recommendation exists for this case." };
  }
  const recommendation = await prisma.recommendation.findUnique({ where: { id: caseRow.currentRecommendationId } });
  if (!recommendation) return { ok: false, step: "not-found", reason: "Draft recommendation not found." };

  const explanation = recommendation.explanation as unknown as ExplanationRecord;
  let schemaValidationError = validateExplanationRecord(explanation);
  if (!schemaValidationError && (explanation.conflict_knowledge || recommendation.promptVersion >= "2026-09-20.1")) {
    schemaValidationError = validateConflictKnowledgeMap(explanation.conflict_knowledge, explanation.knowledge_sources ?? []);
  }

  const caseEvidenceItems = await prisma.evidenceItem.findMany({ where: { caseId: input.caseId, scanStatus: "CLEAN" }, select: { id: true } });
  const caseEvidenceItemIds = new Set(caseEvidenceItems.map((e) => e.id));
  const citedEvidenceItemIds = [
    ...(explanation.evidence_citations ?? []).map((c) => c.evidence_item_id),
    ...(explanation.knowledge_sources ?? []).filter(s => s.kind === "evidence_metadata" || s.kind === "evidence_content").map(s => s.record_id),
  ];

  return runMutation({
    trigger: "issue_recommendation",
    actorId: input.actorId,
    actorRole: input.actorRole,
    fromState: caseRow.state,
    guardContexts: {
      caseAssignedToManager: { actorId: input.actorId, caseManagerId: caseRow.caseManagerId },
      explanationRecordValid: { schemaValidationError },
      citationsResolveToCaseEvidence: { citedEvidenceItemIds, caseEvidenceItemIds },
      reviewerIsIssuingManager: { actorId: input.actorId, caseManagerId: caseRow.caseManagerId },
    },
    write: async (tx) => {
      const locked = await tx.case.updateMany({
        where: { id: input.caseId, state: "DRAFTING", currentRecommendationId: recommendation.id, caseManagerId: input.actorId },
        data: { state: "ISSUED" },
      });
      if (locked.count !== 1) throw new StaleDraftError();
      const issuedAt = new Date();
      const updatedExplanation: ExplanationRecord = {
        ...explanation,
        reviewer: { user_id: input.actorId, issued_at: issuedAt.toISOString() },
      };
      await tx.recommendation.update({
        where: { id: recommendation.id },
        data: {
          status: "ISSUED",
          issuedById: input.actorId,
          issuedAt,
          explanation: updatedExplanation as unknown as Prisma.InputJsonValue,
        },
      });
      await tx.case.update({ where: { id: input.caseId }, data: { state: "ISSUED" } });
      return {
        caseId: input.caseId,
        toState: "ISSUED",
        eventPayloads: [{ type: "RECOMMENDATION_ISSUED", payload: { recommendationId: recommendation.id } }],
        notifications: [
          { userId: caseRow.complainantId, kind: "recommendation_issued", locale: caseRow.complainant.locale },
          { userId: caseRow.respondentId, kind: "recommendation_issued", locale: caseRow.respondent.locale },
        ],
      };
    },
  });
}

// --- give_consent / decline_consent: ISSUED -> DERIVED / RESOLVED_DECLINED -

export interface ConsentActionInput {
  actorId: string;
  actorRole: GlobalRole;
  caseId: string;
  statementVersionId: string;
  /**
   * The statement version the caller has already resolved as "current" for
   * the actor's locale — resolved by the route, same division of
   * responsibility as CreateCaseInput.currentStatementVersionId above (a
   * live "most recent WHERE locale=X" query belongs in exactly one place
   * per request, not repeated inside the mutation function itself; doing it
   * here too caused a real cross-test race under parallel execution — see
   * DECISIONS.md).
   */
  currentStatementVersionId: string | null;
  /** The recommendation id the party saw and is acting on — echoed back so a version issued after page load is caught, not assumed. */
  recommendationId: string;
  /** Section 7: session id, auth method, salted IP hash — built by the route, opaque here. */
  authContext: Prisma.InputJsonValue;
}

export async function giveConsent(input: ConsentActionInput): Promise<MutationOutcome<WriteResult>> {
  const caseRow = await prisma.case.findUnique({
    where: { id: input.caseId },
    include: { complainant: { select: { locale: true } }, respondent: { select: { locale: true } } },
  });
  if (!caseRow) return { ok: false, step: "not-found", reason: "Case not found." };
  if (!caseReadAccess(caseRow, { userId: input.actorId, globalRole: input.actorRole })) return { ok: false, step: "not-found", reason: "Case not found." };
  if (!caseRow.currentRecommendationId) {
    return { ok: false, step: "not-found", reason: "No issued recommendation exists for this case." };
  }
  const recommendationId = caseRow.currentRecommendationId;
  const actorLocale = input.actorId === caseRow.complainantId ? caseRow.complainant.locale : caseRow.respondent.locale;
  const blockers = await loadResolutionBlockers(prisma, input.caseId);

  return runMutation({
    trigger: "give_consent",
    actorId: input.actorId,
    actorRole: input.actorRole,
    fromState: caseRow.state,
    guardContexts: {
      isCaseParty: { actorId: input.actorId, complainantId: caseRow.complainantId, respondentId: caseRow.respondentId },
      consentBindsToCurrentRecommendationVersion: {
        targetRecommendationId: input.recommendationId,
        currentRecommendationId: recommendationId,
      },
      statementVersionIsCurrent: {
        requestedVersionId: input.statementVersionId,
        currentVersionId: input.currentStatementVersionId,
      },
      resolutionNotBlocked: { blockers: blockers.map((code) => ({ code, reason: BLOCKER_REASONS[code] })) },
    },
    write: async (tx) => {
      // Re-check under the case row lock: a contestation opened between the
      // guard and this transaction must still block the consent.
      await tx.$queryRaw`SELECT id FROM "Case" WHERE id = ${input.caseId} FOR UPDATE`;
      const lockedBlockers = await loadResolutionBlockers(tx, input.caseId);
      if (lockedBlockers.length > 0) throw new ResolutionBlockedError(lockedBlockers[0]);
      const givenAt = new Date();
      const existing = await tx.consentRecord.findFirst({ where: { recommendationId, partyId: input.actorId } });
      if (existing) {
        await tx.consentRecord.update({
          where: { id: existing.id },
          data: { state: "GIVEN", givenAt, declinedAt: null, revokedAt: null, authContext: input.authContext, statementVersionId: input.statementVersionId },
        });
      } else {
        await tx.consentRecord.create({
          data: {
            caseId: input.caseId,
            recommendationId,
            partyId: input.actorId,
            state: "GIVEN",
            statementVersionId: input.statementVersionId,
            locale: actorLocale,
            authContext: input.authContext,
            givenAt,
          },
        });
      }

      const otherPartyId = input.actorId === caseRow.complainantId ? caseRow.respondentId : caseRow.complainantId;
      const otherRecord = await tx.consentRecord.findFirst({ where: { recommendationId, partyId: otherPartyId } });
      const complainantState: ConsentState = input.actorId === caseRow.complainantId ? "GIVEN" : otherRecord?.state ?? "NOT_GIVEN";
      const respondentState: ConsentState = input.actorId === caseRow.respondentId ? "GIVEN" : otherRecord?.state ?? "NOT_GIVEN";
      const toState = deriveGiveConsentState(complainantState, respondentState);

      await tx.case.update({ where: { id: input.caseId }, data: { state: toState } });

      return {
        caseId: input.caseId,
        toState,
        eventPayloads: [
          { type: "CONSENT_GIVEN", payload: { recommendationId, partyId: input.actorId } },
          ...(toState === "RESOLVED_CONSENT" ? [{ type: "CASE_RESOLVED" as EventType, payload: {} }] : []),
        ],
        notifications: [
          { userId: caseRow.complainantId, kind: "consent_given", locale: caseRow.complainant.locale },
          { userId: caseRow.respondentId, kind: "consent_given", locale: caseRow.respondent.locale },
        ],
      };
    },
  });
}

export async function declineConsent(input: ConsentActionInput): Promise<MutationOutcome<WriteResult>> {
  const caseRow = await prisma.case.findUnique({
    where: { id: input.caseId },
    include: { complainant: { select: { locale: true } }, respondent: { select: { locale: true } } },
  });
  if (!caseRow) return { ok: false, step: "not-found", reason: "Case not found." };
  if (!caseReadAccess(caseRow, { userId: input.actorId, globalRole: input.actorRole })) return { ok: false, step: "not-found", reason: "Case not found." };
  if (!caseRow.currentRecommendationId) {
    return { ok: false, step: "not-found", reason: "No issued recommendation exists for this case." };
  }
  const recommendationId = caseRow.currentRecommendationId;
  const actorLocale = input.actorId === caseRow.complainantId ? caseRow.complainant.locale : caseRow.respondent.locale;

  return runMutation({
    trigger: "decline_consent",
    actorId: input.actorId,
    actorRole: input.actorRole,
    fromState: caseRow.state,
    guardContexts: {
      isCaseParty: { actorId: input.actorId, complainantId: caseRow.complainantId, respondentId: caseRow.respondentId },
    },
    write: async (tx) => {
      const declinedAt = new Date();
      const existing = await tx.consentRecord.findFirst({ where: { recommendationId, partyId: input.actorId } });
      if (existing) {
        await tx.consentRecord.update({
          where: { id: existing.id },
          data: { state: "DECLINED", declinedAt, authContext: input.authContext, statementVersionId: input.statementVersionId },
        });
      } else {
        await tx.consentRecord.create({
          data: {
            caseId: input.caseId,
            recommendationId,
            partyId: input.actorId,
            state: "DECLINED",
            statementVersionId: input.statementVersionId,
            locale: actorLocale,
            authContext: input.authContext,
            declinedAt,
          },
        });
      }

      await tx.case.update({ where: { id: input.caseId }, data: { state: "RESOLVED_DECLINED" } });

      return {
        caseId: input.caseId,
        toState: "RESOLVED_DECLINED",
        eventPayloads: [
          { type: "CONSENT_DECLINED", payload: { recommendationId, partyId: input.actorId } },
          { type: "CASE_RESOLVED_DECLINED", payload: {} },
        ],
        notifications: [
          { userId: caseRow.complainantId, kind: "consent_declined", locale: caseRow.complainant.locale },
          { userId: caseRow.respondentId, kind: "consent_declined", locale: caseRow.respondent.locale },
        ],
      };
    },
  });
}

// --- revoke_consent: ISSUED|RESOLVED_CONSENT -> ISSUED --------------------

export interface RevokeConsentInput {
  actorId: string;
  actorRole: GlobalRole;
  caseId: string;
}

export async function revokeConsent(input: RevokeConsentInput): Promise<MutationOutcome<WriteResult>> {
  const caseRow = await prisma.case.findUnique({
    where: { id: input.caseId },
    include: { complainant: { select: { locale: true } }, respondent: { select: { locale: true } } },
  });
  if (!caseRow) return { ok: false, step: "not-found", reason: "Case not found." };
  if (!caseReadAccess(caseRow, { userId: input.actorId, globalRole: input.actorRole })) return { ok: false, step: "not-found", reason: "Case not found." };
  if (!caseRow.currentRecommendationId) {
    return { ok: false, step: "not-found", reason: "No issued recommendation exists for this case." };
  }
  const recommendationId = caseRow.currentRecommendationId;

  const existing = await prisma.consentRecord.findFirst({ where: { recommendationId, partyId: input.actorId } });
  if (!existing) {
    return { ok: false, step: "not-found", reason: "No consent record exists for this party on the current recommendation." };
  }

  return runMutation({
    trigger: "revoke_consent",
    actorId: input.actorId,
    actorRole: input.actorRole,
    fromState: caseRow.state,
    guardContexts: {
      isConsentingParty: { actorId: input.actorId, consentPartyId: existing.partyId },
      caseNotClosed: { state: caseRow.state },
    },
    write: async (tx) => {
      await tx.consentRecord.update({ where: { id: existing.id }, data: { state: "REVOKED", revokedAt: new Date() } });
      await tx.case.update({ where: { id: input.caseId }, data: { state: "ISSUED" } });
      return {
        caseId: input.caseId,
        toState: "ISSUED",
        eventPayloads: [
          { type: "CONSENT_REVOKED", payload: { recommendationId, partyId: input.actorId } },
          { type: "CASE_REOPENED", payload: {} },
        ],
        notifications: [
          { userId: caseRow.complainantId, kind: "consent_revoked", locale: caseRow.complainant.locale },
          { userId: caseRow.respondentId, kind: "consent_revoked", locale: caseRow.respondent.locale },
        ],
      };
    },
  });
}

// --- request_new_version: RESOLVED_DECLINED|ISSUED -> DRAFTING ------------

export interface RequestNewVersionInput {
  actorId: string;
  actorRole: GlobalRole;
  caseId: string;
}

export async function requestNewVersion(input: RequestNewVersionInput): Promise<MutationOutcome<WriteResult>> {
  const caseRow = await prisma.case.findUnique({ where: { id: input.caseId } });
  if (!caseRow) return { ok: false, step: "not-found", reason: "Case not found." };
  if (!caseReadAccess(caseRow, { userId: input.actorId, globalRole: input.actorRole })) return { ok: false, step: "not-found", reason: "Case not found." };
  if (!caseRow.currentRecommendationId) {
    return { ok: false, step: "not-found", reason: "No recommendation exists to supersede." };
  }
  const priorRecommendation = await prisma.recommendation.findUnique({ where: { id: caseRow.currentRecommendationId } });
  if (!priorRecommendation) return { ok: false, step: "not-found", reason: "Recommendation not found." };

  const maxVersion = await prisma.recommendation.aggregate({ where: { caseId: input.caseId }, _max: { version: true } });
  const currentMaxVersion = maxVersion._max.version ?? 0;
  const requestedVersion = currentMaxVersion + 1;

  const draftRequestId = randomUUID();
  return runMutation({
    trigger: "request_new_version",
    actorId: input.actorId,
    actorRole: input.actorRole,
    fromState: caseRow.state,
    guardContexts: {
      caseAssignedToManager: { actorId: input.actorId, caseManagerId: caseRow.caseManagerId },
      newVersionNumber: { requestedVersion, currentMaxVersion },
      priorRecommendationSuperseded: { priorRecommendationStatus: priorRecommendation.status },
    },
    write: async (tx) => {
      const locked = await tx.case.updateMany({ where: { id: input.caseId, state: caseRow.state, currentRecommendationId: priorRecommendation.id, caseManagerId: input.actorId }, data: { draftRequestId, draftRequestedAt: new Date() } });
      if (locked.count !== 1) throw new StaleDraftError();
      await tx.recommendation.update({ where: { id: priorRecommendation.id }, data: { status: "SUPERSEDED" } });
      await tx.case.update({ where: { id: input.caseId }, data: { state: "DRAFTING", currentRecommendationId: null } });
      return {
        caseId: input.caseId,
        toState: "DRAFTING",
        draftRequestId,
        eventPayloads: [
          {
            type: "RECOMMENDATION_DRAFT_REQUESTED",
            payload: { draftRequestId, supersedesRecommendationId: priorRecommendation.id, newVersion: requestedVersion },
          },
        ],
      };
    },
  });
}

// --- withdraw: ANY_EXCEPT_CLOSED -> WITHDRAWN ------------------------------

export interface WithdrawCaseInput {
  actorId: string;
  actorRole: GlobalRole;
  caseId: string;
}

export async function withdrawCase(input: WithdrawCaseInput): Promise<MutationOutcome<WriteResult>> {
  const caseRow = await prisma.case.findUnique({
    where: { id: input.caseId },
    include: { respondent: { select: { locale: true } } },
  });
  if (!caseRow) return { ok: false, step: "not-found", reason: "Case not found." };
  if (!caseReadAccess(caseRow, { userId: input.actorId, globalRole: input.actorRole })) return { ok: false, step: "not-found", reason: "Case not found." };

  return runMutation({
    trigger: "withdraw",
    actorId: input.actorId,
    actorRole: input.actorRole,
    fromState: caseRow.state,
    guardContexts: {
      isCaseOwner: { actorId: input.actorId, complainantId: caseRow.complainantId },
    },
    write: async (tx) => {
      await tx.case.update({ where: { id: input.caseId }, data: { state: "WITHDRAWN" } });
      return {
        caseId: input.caseId,
        toState: "WITHDRAWN",
        eventPayloads: [{ type: "CASE_WITHDRAWN", payload: {} }],
        notifications: [{ userId: caseRow.respondentId, kind: "case_withdrawn", locale: caseRow.respondent.locale }],
      };
    },
  });
}

// --- close_case: RESOLVED_CONSENT|RESOLVED_DECLINED|WITHDRAWN -> CLOSED ---

export interface CloseCaseInput {
  actorId: string;
  actorRole: GlobalRole;
  caseId: string;
  /** The export bundle's SHA-256, already generated by generateExportBundle() before this is called. */
  exportSha256: string;
}

export async function closeCase(input: CloseCaseInput): Promise<MutationOutcome<WriteResult>> {
  const caseRow = await prisma.case.findUnique({ where: { id: input.caseId } });
  if (!caseRow) return { ok: false, step: "not-found", reason: "Case not found." };
  if (!caseReadAccess(caseRow, { userId: input.actorId, globalRole: input.actorRole })) return { ok: false, step: "not-found", reason: "Case not found." };

  return runMutation({
    trigger: "close_case",
    actorId: input.actorId,
    actorRole: input.actorRole,
    fromState: caseRow.state,
    guardContexts: {
      caseAssignedToManager: { actorId: input.actorId, caseManagerId: caseRow.caseManagerId },
      exportBundleGeneratedAndHashed: { exportSha256: input.exportSha256 },
    },
    write: async (tx) => {
      const closedAt = new Date();
      await tx.case.update({ where: { id: input.caseId }, data: { state: "CLOSED", closedAt } });
      return {
        caseId: input.caseId,
        toState: "CLOSED",
        eventPayloads: [
          { type: "EXPORT_GENERATED", payload: { sha256: input.exportSha256 } },
          { type: "CASE_CLOSED", payload: {} },
        ],
      };
    },
  });
}

/** A human correction creates a new draft version and keeps the original record intact. */
export async function reviewDraft(input: {
  actorId: string; actorRole: GlobalRole; caseId: string;
  recommendationId: string; fields: unknown; reason: string;
}): Promise<MutationOutcome<WriteResult>> {
  const row = await prisma.case.findUnique({ where: { id: input.caseId } });
  if (!row || row.caseManagerId !== input.actorId || input.actorRole !== "CASE_MANAGER") {
    return { ok: false, step: "not-found", reason: "Case not found." };
  }
  const prior = await prisma.recommendation.findUnique({ where: { id: input.recommendationId } });
  if (!prior || prior.caseId !== row.id || row.currentRecommendationId !== prior.id || prior.status !== "DRAFT") {
    return { ok: false, step: "guard", reason: "The draft changed. Reload before reviewing it." };
  }
  const parsed = coreAiGeneratedFieldsSchema.safeParse(input.fields);
  if (!parsed.success || !input.reason.trim() || input.reason.length > 8000) {
    return { ok: false, step: "guard", reason: "A complete valid explanation, conflict map and review reason are required." };
  }
  const original = prior.explanation as unknown as ExplanationRecord;
  const sources = original.knowledge_sources ?? [];
  const schemaValidationError = validateConflictKnowledgeMap(parsed.data.conflict_knowledge, sources);
  const clean = await prisma.evidenceItem.findMany({ where: { caseId: row.id, scanStatus: "CLEAN" }, select: { id: true } });
  if (parsed.data.evidence_citations.some(c => !clean.some(e => e.id === c.evidence_item_id))) {
    return { ok: false, step: "guard", reason: "Citation does not resolve to clean case evidence." };
  }
  return runMutation({
    trigger: "review_draft", actorId: input.actorId, actorRole: input.actorRole, fromState: row.state,
    guardContexts: {
      caseAssignedToManager: { actorId: input.actorId, caseManagerId: row.caseManagerId },
      explanationRecordValid: { schemaValidationError },
    },
    write: async tx => {
      const locked = await tx.case.updateMany({
        where: { id: row.id, state: "DRAFTING", currentRecommendationId: prior.id, caseManagerId: input.actorId },
        data: { state: "DRAFTING" },
      });
      if (locked.count !== 1) throw new StaleDraftError();
      const explanation: ExplanationRecord = {
        ...parsed.data, knowledge_sources: sources, model: original.model,
        reviewer: { user_id: null, issued_at: null },
      };
      const latest = await tx.recommendation.findFirst({ where: { caseId: row.id }, orderBy: { version: "desc" } });
      const revised = await tx.recommendation.create({ data: {
        caseId: row.id, version: (latest?.version ?? 0) + 1, status: "DRAFT",
        explanation: explanation as unknown as Prisma.InputJsonValue,
        modelId: prior.modelId, promptVersion: prior.promptVersion,
      } });
      await tx.recommendation.update({ where: { id: prior.id }, data: { status: "SUPERSEDED" } });
      await tx.case.update({ where: { id: row.id }, data: { currentRecommendationId: revised.id } });
      return { caseId: row.id, toState: "DRAFTING", eventPayloads: [
        { type: "RECOMMENDATION_DRAFTED", payload: { recommendationId: revised.id, version: revised.version, supersedesId: prior.id, origin: "human_review" } },
        { type: "NOTE_ADDED", payload: { kind: "conflict_knowledge_review", recommendationId: revised.id, priorRecommendationId: prior.id, reason: input.reason } },
      ] };
    },
  });
}
