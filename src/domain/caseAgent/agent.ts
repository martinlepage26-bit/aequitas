import { createHash } from "node:crypto";
import type { GlobalRole, Prisma } from "../../generated/prisma";
import { prisma } from "../../lib/prisma";
import { deliverPendingNotifications } from "../../lib/mail";
import type { TextCompletion } from "../pipeline/provider";
import { resolveFreeTextModel } from "../pipeline/provider";
import { appendEvent } from "../events";
import { validateExplanationRecord, type ExplanationRecord } from "../explanationRecord";
import { generateExportBundle } from "../exportBundle";
import { extractStoredEvidence, MAX_CASE_EXTRACTED_CHARACTERS, MAX_EVIDENCE_FILES, type EvidenceExtraction } from "../../lib/evidenceText";
import { digestPartyOutcomeCitations, type PartyOutcomeCitationPointer } from "../partyOutcomeCitations";
import { runMutation, type MutationOutcome, type WriteResult } from "../mutate";
import { AGENT_PROMPT_VERSION, checkAgentOutput } from "./output";
import { buildCaseAgentOutputContext, buildCaseAgentPrompt } from "./prompt";

/**
 * Prototype case agent for one Québec retail-dispute program.
 *
 * Scope: after intake closes and both positions are in, it checks the file,
 * asks the configured model for an evidence-cited summary and one
 * non-binding proposed outcome per party, validates that output, and issues
 * it. Each party then consents or declines through the existing consent
 * flow. It closes a case only after both parties consent or the complainant
 * withdraws. Anything else goes to the assigned human case manager.
 *
 * It acts through its own CASE_AGENT account, which holds only the
 * agent_issue and agent_close transitions (stateMachine.ts). It cannot
 * approve, consent, open intake, read sessions, or act as an administrator.
 */

export const CASE_AGENT_EMAIL = "case-agent@aequitas.invalid";

export type EscalationReason =
  | "party_request"
  | "out_of_scope_category"
  | "out_of_scope_amount"
  | "evidence_inadequate"
  | "evidence_rejected"
  | "evidence_extraction_failed"
  | "evidence_limit_exceeded"
  | "contestation_open"
  | "declined"
  | "model_unavailable"
  | "model_failed"
  | "model_requested_review"
  | "model_output_rejected";

export type AgentRunResult =
  | { status: "skipped"; reason: string }
  | { status: "waiting"; reason: string }
  | { status: "stale" }
  | { status: "issued"; recommendationId: string }
  | { status: "closed" }
  | { status: "escalated"; reason: EscalationReason };

type Env = Record<string, string | undefined>;

export function caseAgentEnabled(env: Env = process.env): boolean {
  return env.AEQUITAS_CASE_AGENT_ENABLED === "true";
}

/** The program's amount ceiling in CAD cents. Unset means no case is in scope. */
export function caseAgentAmountCap(env: Env = process.env): number | null {
  const value = Number(env.AEQUITAS_CASE_AGENT_MAX_AMOUNT_CENTS);
  return Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * Runtime model through the existing provider interface (Gemini or Workers
 * AI, never Anthropic or OpenAI in this path). Gated by the agent flag, not
 * the pipeline flag. Calls are made and billed by the deployment's own
 * provider account.
 */
export function resolveCaseAgentModel(env: Env = process.env, fetchImpl: typeof fetch = fetch) {
  if (!caseAgentEnabled(env)) return { ok: false as const, reason: "The case agent is off. Set AEQUITAS_CASE_AGENT_ENABLED=true." };
  return resolveFreeTextModel({ ...env, AEQUITAS_PIPELINE_ENABLED: "true" }, fetchImpl);
}

export async function loadCaseAgentAccount() {
  const accounts = await prisma.user.findMany({ where: { globalRole: "CASE_AGENT" }, select: { id: true } });
  if (accounts.length !== 1) return null;
  return accounts[0];
}

// --- enrollment and escalation ------------------------------------------

type Outcome = { ok: true } | { ok: false; status: 403 | 404 | 409; reason: string };

/** The assigned case manager hands routine steps of one retail case to the agent. */
export async function enrollCaseAgent(input: { actorId: string; actorRole: GlobalRole; caseId: string }, env: Env = process.env): Promise<Outcome> {
  const caseRow = await prisma.case.findUnique({ where: { id: input.caseId } });
  if (!caseRow || input.actorRole !== "CASE_MANAGER" || caseRow.caseManagerId !== input.actorId) return { ok: false, status: 404, reason: "Case not found." };
  if (!caseAgentEnabled(env)) return { ok: false, status: 409, reason: "The case agent is not enabled on this deployment." };
  if (!(await loadCaseAgentAccount())) return { ok: false, status: 409, reason: "The case agent account is not provisioned." };
  if (caseRow.category !== "RETAIL") return { ok: false, status: 409, reason: "The case agent handles retail disputes only." };
  if (caseRow.state !== "EVIDENCE_INTAKE" && caseRow.state !== "POSITIONS") return { ok: false, status: 409, reason: "The case agent can be enabled during intake or positions only." };
  if (caseRow.agentManaged) return { ok: true };
  await prisma.$transaction(async (tx) => {
    const updated = await tx.case.updateMany({ where: { id: caseRow.id, agentManaged: false, state: caseRow.state }, data: { agentManaged: true } });
    if (updated.count === 1) await appendEvent(tx, { caseId: caseRow.id, type: "AGENT_ENROLLED", actorId: input.actorId, payload: {} });
  });
  return { ok: true };
}

async function escalateCase(caseId: string, actorId: string, reason: EscalationReason): Promise<boolean> {
  const escalated = await prisma.$transaction(async (tx) => {
    const row = await tx.case.findUniqueOrThrow({ where: { id: caseId }, include: { caseManager: { select: { locale: true } } } });
    const updated = await tx.case.updateMany({
      where: { id: caseId, agentManaged: true, agentEscalatedAt: null, state: { not: "CLOSED" } },
      data: { agentEscalatedAt: new Date(), agentEscalationReason: reason },
    });
    if (updated.count !== 1) return false;
    await appendEvent(tx, { caseId, type: "AGENT_ESCALATED", actorId, payload: { reason } });
    if (row.caseManagerId) {
      await tx.notification.create({ data: { userId: row.caseManagerId, caseId, kind: "agent_escalated", locale: row.caseManager?.locale ?? "fr-CA" } });
    }
    return true;
  });
  if (escalated) {
    try { await deliverPendingNotifications(caseId); } catch { console.error("Notification dispatch unavailable; retained for retry."); }
  }
  return escalated;
}

/** Either party asks for a person. The agent stops at once; approver sign-off applies again. */
export async function requestHumanReview(input: { actorId: string; actorRole: GlobalRole; caseId: string }): Promise<Outcome> {
  const caseRow = await prisma.case.findUnique({ where: { id: input.caseId } });
  const isParty = caseRow && ((input.actorRole === "COMPLAINANT" && caseRow.complainantId === input.actorId) || (input.actorRole === "RESPONDENT" && caseRow.respondentId === input.actorId));
  if (!caseRow || !isParty) return { ok: false, status: 404, reason: "Case not found." };
  if (!caseRow.agentManaged || caseRow.state === "CLOSED") return { ok: false, status: 409, reason: "This case is not managed by the automated assistant." };
  if (caseRow.agentEscalatedAt) return { ok: true };
  await escalateCase(caseRow.id, input.actorId, "party_request");
  return { ok: true };
}

// --- one agent pass over one case -----------------------------------------

class StaleAgentWrite extends Error {}

async function loadMaterial(caseId: string) {
  const caseRow = await prisma.case.findUniqueOrThrow({
    where: { id: caseId },
    include: {
      complainant: { select: { id: true, locale: true } },
      respondent: { select: { id: true, locale: true } },
      evidenceItems: { orderBy: { createdAt: "asc" } },
      chronologyEntries: { orderBy: [{ occurredOn: "asc" }, { createdAt: "asc" }] },
    },
  });
  const latestPosition = (partyId: string) => prisma.positionStatement.findFirst({ where: { caseId, partyId }, orderBy: { version: "desc" } });
  const [complainantPosition, respondentPosition, openContestations] = await Promise.all([
    latestPosition(caseRow.complainantId),
    latestPosition(caseRow.respondentId),
    prisma.contestation.count({ where: { caseId, status: "OPEN" } }),
  ]);
  const superseded = new Set(caseRow.evidenceItems.map((e) => e.supersedesId).filter(Boolean));
  const current = caseRow.evidenceItems.filter((e) => !superseded.has(e.id));
  return { caseRow, complainantPosition, respondentPosition, openContestations, current };
}

type Material = Awaited<ReturnType<typeof loadMaterial>>;

type AgentEvidenceSource = {
  text: string;
  method: Exclude<EvidenceExtraction["method"], "none">;
  sourceSha256: string;
  extractedTextSha256: string;
};

/** Changes when anything the model saw changes; only this digest enters the event log. */
function materialDigest(m: Material, evidenceSources: ReadonlyMap<string, AgentEvidenceSource>): string {
  const parts = {
    case: [m.caseRow.category, m.caseRow.disputeDescription, m.caseRow.amountAtStakeCents, m.caseRow.complainant.locale, m.caseRow.respondent.locale],
    positions: [m.complainantPosition, m.respondentPosition].map((p) => p && [p.id, p.version, p.body, p.locale]),
    evidence: m.caseRow.evidenceItems.map((e) => [e.id, e.version, e.scanStatus, e.supersedesId, e.sha256, e.byteSize, e.mimeType, e.title, e.description]),
    extractedEvidence: [...evidenceSources].map(([id, source]) => [id, source.extractedTextSha256]),
    chronology: m.caseRow.chronologyEntries.map((c) => [c.id, c.occurredOn, c.title, c.description, c.submittedById]),
    openContestations: m.openContestations,
    recommendation: m.caseRow.currentRecommendationId,
  };
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/**
 * One idempotent pass. Safe to repeat: every write re-checks the case row
 * under lock, and a change to the material during the model call discards
 * the result ("stale") for the next pass.
 */
export async function runCaseAgent(input: { caseId: string; model: TextCompletion | null; env?: Env }): Promise<AgentRunResult> {
  const env = input.env ?? process.env;
  if (!caseAgentEnabled(env)) return { status: "skipped", reason: "agent_disabled" };
  const agent = await loadCaseAgentAccount();
  if (!agent) return { status: "skipped", reason: "agent_account_missing" };
  const first = await loadMaterial(input.caseId);
  const row = first.caseRow;
  if (!row.agentManaged) return { status: "skipped", reason: "not_enrolled" };
  if (row.agentEscalatedAt) return { status: "skipped", reason: "escalated" };
  const escalate = async (reason: EscalationReason): Promise<AgentRunResult> => {
    await escalateCase(row.id, agent.id, reason);
    return { status: "escalated", reason };
  };

  switch (row.state) {
    case "POSITIONS":
      break;
    case "ISSUED":
      return first.openContestations > 0 ? escalate("contestation_open") : { status: "waiting", reason: "awaiting_answers" };
    case "RESOLVED_DECLINED":
      // A refusal ends the routine path. A person decides what happens next.
      return escalate("declined");
    case "RESOLVED_CONSENT":
    case "WITHDRAWN":
      return closeAsAgent(row.id, agent.id);
    default:
      return { status: "waiting", reason: `state_${row.state.toLowerCase()}` };
  }

  // Scope and completeness checks. No model is called until these pass.
  if (!first.complainantPosition || !first.respondentPosition) return { status: "waiting", reason: "positions_missing" };
  if (row.category !== "RETAIL") return escalate("out_of_scope_category");
  const cap = caseAgentAmountCap(env);
  if (cap === null || row.amountAtStakeCents === null || row.amountAtStakeCents > cap) return escalate("out_of_scope_amount");
  if (first.current.some((e) => e.scanStatus === "PENDING")) return { status: "waiting", reason: "scan_pending" };
  if (first.current.some((e) => e.scanStatus === "REJECTED")) return escalate("evidence_rejected");
  const clean = (partyId: string) => new Set(first.current.filter((e) => e.submittedById === partyId && e.scanStatus === "CLEAN").map((e) => e.id));
  const complainantEvidenceIds = clean(row.complainantId);
  const respondentEvidenceIds = clean(row.respondentId);
  if (complainantEvidenceIds.size === 0 || respondentEvidenceIds.size === 0) return escalate("evidence_inadequate");
  if (first.openContestations > 0) return escalate("contestation_open");
  if (!input.model) return escalate("model_unavailable");

  const cleanItems = first.current.filter((e) => e.scanStatus === "CLEAN");
  if (cleanItems.length > MAX_EVIDENCE_FILES) return escalate("evidence_limit_exceeded");
  const evidenceSources = new Map<string, AgentEvidenceSource>();
  let extractedCharacters = 0;
  for (const item of cleanItems) {
    let extraction: EvidenceExtraction;
    try { extraction = await extractStoredEvidence(item); }
    catch { return escalate("evidence_extraction_failed"); }
    if (extraction.status !== "extracted" || extraction.method === "none") return escalate("evidence_extraction_failed");
    extractedCharacters += extraction.text.length;
    if (extractedCharacters > MAX_CASE_EXTRACTED_CHARACTERS) return escalate("evidence_limit_exceeded");
    evidenceSources.set(item.id, {
      text: extraction.text,
      method: extraction.method,
      sourceSha256: item.sha256,
      extractedTextSha256: createHash("sha256").update(extraction.text).digest("hex"),
    });
  }

  const digest = materialDigest(first, evidenceSources);
  let raw: string;
  try {
    raw = await input.model.complete(buildCaseAgentPrompt(first, evidenceSources));
  } catch {
    return escalate("model_failed");
  }
  const context = buildCaseAgentOutputContext(first, evidenceSources);
  const checked = checkAgentOutput(raw, context);
  if (!checked.ok) return escalate(checked.escalation);
  const out = checked.value;

  const modelId = `agent:${input.model.provider}:${input.model.model}`;
  const evidenceCitations = out.citations.map(({ excerpt, ...citation }) => {
    const source = evidenceSources.get(citation.evidence_item_id)!;
    const start = source.text.indexOf(excerpt);
    const startChar = Array.from(source.text.slice(0, start)).length;
    return {
      ...citation,
      extracted_span: {
        start_char: startChar,
        end_char: startChar + Array.from(excerpt).length,
        source_sha256: source.sourceSha256,
        extracted_text_sha256: source.extractedTextSha256,
        extraction_method: source.method,
      },
    };
  });
  const explanation: ExplanationRecord = {
    summary: out.summary,
    proposed_outcome: "Separate non-binding outcomes were proposed to each party.",
    reasoning: out.reasoning,
    evidence_citations: evidenceCitations,
    limits: out.limits,
    not_considered: out.not_considered,
    knowledge_sources: [],
    model: { id: modelId, prompt_version: AGENT_PROMPT_VERSION },
    reviewer: { user_id: null, issued_at: null },
  };
  const schemaValidationError = validateExplanationRecord(explanation);
  const caseEvidenceItemIds = new Set([...complainantEvidenceIds, ...respondentEvidenceIds]);

  try {
    const result = await runMutation({
      trigger: "agent_issue",
      actorId: agent.id,
      actorRole: "CASE_AGENT",
      fromState: row.state,
      guardContexts: {
        agentMayAct: { agentManaged: row.agentManaged, escalated: Boolean(row.agentEscalatedAt), actorIsCaseAgent: true },
        bothPartiesHaveCurrentPositions: { complainantHasPosition: true, respondentHasPosition: true },
        explanationRecordValid: { schemaValidationError },
        citationsResolveToCaseEvidence: { citedEvidenceItemIds: out.citations.map((c) => c.evidence_item_id), caseEvidenceItemIds },
      },
      write: async (tx) => {
        const locked = await tx.case.updateMany({
          where: { id: row.id, state: "POSITIONS", agentManaged: true, agentEscalatedAt: null, currentRecommendationId: row.currentRecommendationId, draftRequestId: null },
          data: { state: "ISSUED" },
        });
        if (locked.count !== 1) throw new StaleAgentWrite();
        if (materialDigest(await loadMaterialIn(tx, row.id), evidenceSources) !== digest) throw new StaleAgentWrite();
        const issuedAt = new Date();
        const latest = await tx.recommendation.findFirst({ where: { caseId: row.id }, orderBy: { version: "desc" }, select: { version: true } });
        const recommendation = await tx.recommendation.create({
          data: {
            caseId: row.id, version: (latest?.version ?? 0) + 1, status: "ISSUED",
            explanation: { ...explanation, reviewer: { user_id: null, issued_at: issuedAt.toISOString() } } as unknown as Prisma.InputJsonValue,
            modelId, promptVersion: AGENT_PROMPT_VERSION, issuedById: agent.id, issuedAt,
          },
        });
        await tx.case.update({ where: { id: row.id }, data: { currentRecommendationId: recommendation.id } });
        const outcomeEvents: WriteResult["eventPayloads"] = [];
        for (const [partyId, locale, body, evidenceItemIds] of [
          [row.complainantId, row.complainant.locale, out.outcomes.complainant.text, out.outcomes.complainant.evidence_item_ids],
          [row.respondentId, row.respondent.locale, out.outcomes.respondent.text, out.outcomes.respondent.evidence_item_ids],
        ] as const) {
          const partyEvidenceIds = new Set(evidenceItemIds);
          const citationPointers: PartyOutcomeCitationPointer[] = evidenceCitations
            .filter((citation) => partyEvidenceIds.has(citation.evidence_item_id))
            .map((citation) => ({
              evidenceItemId: citation.evidence_item_id,
              relevance: citation.relevance,
              startChar: citation.extracted_span.start_char,
              endChar: citation.extracted_span.end_char,
              sourceSha256: citation.extracted_span.source_sha256,
              extractedTextSha256: citation.extracted_span.extracted_text_sha256,
              extractionMethod: citation.extracted_span.extraction_method,
            }));
          const prior = await tx.partyOutcome.findFirst({ where: { caseId: row.id, partyId }, orderBy: { version: "desc" }, select: { version: true } });
          const outcome = await tx.partyOutcome.create({
            data: { caseId: row.id, partyId, version: (prior?.version ?? 0) + 1, status: "ISSUED", body, locale, authoredById: agent.id, issuedAt },
          });
          await tx.partyOutcomeCitation.createMany({ data: citationPointers.map((citation) => ({ partyOutcomeId: outcome.id, ...citation })) });
          outcomeEvents.push({
            type: "PARTY_OUTCOME_ISSUED",
            payload: { partyId, outcomeId: outcome.id, version: outcome.version, citationDigest: digestPartyOutcomeCitations(citationPointers) },
          });
        }
        return {
          caseId: row.id,
          toState: "ISSUED",
          eventPayloads: [
            { type: "RECOMMENDATION_DRAFT_REQUESTED", payload: { origin: "case_agent" } },
            { type: "RECOMMENDATION_DRAFTED", payload: { recommendationId: recommendation.id, version: recommendation.version, origin: "case_agent", materialDigest: digest, model: modelId, promptVersion: AGENT_PROMPT_VERSION } },
            { type: "RECOMMENDATION_ISSUED", payload: { recommendationId: recommendation.id, origin: "case_agent" } },
            ...outcomeEvents,
          ],
          notifications: [
            { userId: row.complainantId, kind: "recommendation_issued", locale: row.complainant.locale },
            { userId: row.respondentId, kind: "recommendation_issued", locale: row.respondent.locale },
          ],
        };
      },
    });
    if (!result.ok) return escalate("model_output_rejected");
    const after = await prisma.case.findUniqueOrThrow({ where: { id: row.id }, select: { currentRecommendationId: true } });
    return { status: "issued", recommendationId: after.currentRecommendationId! };
  } catch (error) {
    if (error instanceof StaleAgentWrite) return { status: "stale" };
    throw error;
  }
}

async function loadMaterialIn(tx: Prisma.TransactionClient, caseId: string): Promise<Material> {
  const caseRow = await tx.case.findUniqueOrThrow({
    where: { id: caseId },
    include: {
      complainant: { select: { id: true, locale: true } },
      respondent: { select: { id: true, locale: true } },
      evidenceItems: { orderBy: { createdAt: "asc" } },
      chronologyEntries: { orderBy: [{ occurredOn: "asc" }, { createdAt: "asc" }] },
    },
  });
  const latestPosition = (partyId: string) => tx.positionStatement.findFirst({ where: { caseId, partyId }, orderBy: { version: "desc" } });
  const [complainantPosition, respondentPosition, openContestations] = await Promise.all([
    latestPosition(caseRow.complainantId),
    latestPosition(caseRow.respondentId),
    tx.contestation.count({ where: { caseId, status: "OPEN" } }),
  ]);
  const superseded = new Set(caseRow.evidenceItems.map((e) => e.supersedesId).filter(Boolean));
  return { caseRow, complainantPosition, respondentPosition, openContestations, current: caseRow.evidenceItems.filter((e) => !superseded.has(e.id)) };
}

async function closeAsAgent(caseId: string, agentId: string): Promise<AgentRunResult> {
  const row = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
  const bundle = await generateExportBundle({ caseId, actorId: agentId });
  const closed: MutationOutcome<WriteResult> = await runMutation({
    trigger: "agent_close",
    actorId: agentId,
    actorRole: "CASE_AGENT",
    fromState: row.state,
    guardContexts: {
      agentMayAct: { agentManaged: row.agentManaged, escalated: Boolean(row.agentEscalatedAt), actorIsCaseAgent: true },
      exportBundleGeneratedAndHashed: { exportSha256: bundle.sha256 },
    },
    write: async (tx) => {
      const locked = await tx.case.updateMany({ where: { id: caseId, state: row.state, agentManaged: true, agentEscalatedAt: null }, data: { state: "CLOSED", closedAt: new Date() } });
      if (locked.count !== 1) throw new StaleAgentWrite();
      return { caseId, toState: "CLOSED", eventPayloads: [{ type: "EXPORT_GENERATED", payload: { sha256: bundle.sha256 } }, { type: "CASE_CLOSED", payload: { origin: "case_agent" } }] };
    },
  }).catch((error) => {
    if (error instanceof StaleAgentWrite) return { ok: false, step: "guard", reason: "stale" } as const;
    throw error;
  });
  if (!closed.ok) return closed.reason === "stale" ? { status: "stale" } : { status: "waiting", reason: closed.reason };
  return { status: "closed" };
}
