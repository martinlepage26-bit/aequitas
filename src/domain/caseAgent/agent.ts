import { createHash } from "node:crypto";
import type { GlobalRole, Prisma } from "../../generated/prisma";
import { prisma } from "../../lib/prisma";
import { deliverPendingNotifications } from "../../lib/mail";
import type { TextCompletion } from "../pipeline/provider";
import { resolveCaseDataModel } from "../pipeline/provider";
import { appendEvent } from "../events";
import { validateExplanationRecord, type ExplanationRecord } from "../explanationRecord";
import { generateExportBundle } from "../exportBundle";
import { extractStoredEvidence, MAX_CASE_EXTRACTED_CHARACTERS, MAX_EVIDENCE_FILES, type EvidenceExtraction } from "../../lib/evidenceText";
import { digestPartyOutcomeCitations, type PartyOutcomeCitationPointer } from "../partyOutcomeCitations";
import { runMutation, type MutationOutcome, type WriteResult } from "../mutate";
import { AGENT_OUTPUT_JSON_SCHEMA, AGENT_PROMPT_VERSION, checkAgentOutput } from "./output";
import { buildCaseAgentOutputContext, buildCaseAgentPrompt } from "./prompt";
import { caseAgentEnabled, caseAgentProgram, DAY_MS, type CaseAgentProgram } from "./config";
import { renderProposal } from "./proposal";
import { CASE_AGENT_POSITIONS_REQUESTED_KIND, EmailDeliveryError, emailConfigured, sendInvitationEmail } from "../../lib/mail";
import { invitationTokenHash, revokeInvitation } from "../../lib/invitations";
import { invitePath, issueInviteToken } from "../../lib/invite";

export { caseAgentEnabled } from "./config";

/**
 * Prototype case agent for one Québec retail-dispute program.
 *
 * Routine path, all decided by deterministic code under the program's
 * configured rules (config.ts): take an eligible submitted case, open intake,
 * send the existing respondent invitation, close intake after both parties
 * mark their evidence complete, wait for positions, ask the model for a cited
 * summary and structured proposal, verify it, issue fixed-text outcomes to each party,
 * record answers through the existing consent flow, and close after both
 * consents or a withdrawal. Every exception stops the agent and goes to a
 * person: the assigned case manager, or the case-manager queue.
 *
 * It acts through its own CASE_AGENT account, which holds only the agent_*
 * transitions (stateMachine.ts). It cannot sign in, read through any route,
 * approve, consent, administer users, or act on an escalated case.
 */

export const CASE_AGENT_EMAIL = "case-agent@aequitas.invalid";

export type EscalationReason =
  | "party_request"
  | "invitation_failed"
  | "respondent_no_response"
  | "submission_missing"
  | "intake_incomplete"
  | "evidence_scan_pending"
  | "no_answer"
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
  | "model_output_rejected"
  | "program_rules_incomplete";

export type AgentRunResult =
  | { status: "skipped"; reason: string }
  | { status: "waiting"; reason: string }
  | { status: "stale" }
  | { status: "issued"; recommendationId: string }
  | { status: "closed" }
  | { status: "intake_opened" }
  | { status: "intake_closed" }
  | { status: "respondent_invited" }
  | { status: "escalated"; reason: EscalationReason };

type Env = Record<string, string | undefined>;

/**
 * Runtime model through the existing provider interface (Gemini or Workers
 * AI, never Anthropic or OpenAI in this path). Gated by the agent flag, not
 * the pipeline flag. Calls are made and billed by the deployment's own
 * provider account.
 */
export function resolveCaseAgentModel(env: Env = process.env, fetchImpl: typeof fetch = fetch) {
  if (!caseAgentEnabled(env)) return { ok: false as const, reason: "The case agent is off or its program rules are incomplete." };
  return resolveCaseDataModel({ ...env, AEQUITAS_PIPELINE_ENABLED: "true" }, fetchImpl);
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
  const config = caseAgentProgram(env);
  if (!config.ok) return { ok: false, status: 409, reason: "The case agent is not fully configured on this deployment." };
  if (!resolveCaseAgentModel(env).ok) return { ok: false, status: 409, reason: "The case agent's approved model provider is not configured." };
  if (!(await loadCaseAgentAccount())) return { ok: false, status: 409, reason: "The case agent account is not provisioned." };
  if (caseRow.category !== "RETAIL") return { ok: false, status: 409, reason: "The case agent handles retail disputes only." };
  if (caseRow.state !== "EVIDENCE_INTAKE" && caseRow.state !== "POSITIONS") return { ok: false, status: 409, reason: "The case agent can be enabled during intake or positions only." };
  if (caseRow.agentManaged) return { ok: true };
  await prisma.$transaction(async (tx) => {
    const updated = await tx.case.updateMany({ where: { id: caseRow.id, agentManaged: false, state: caseRow.state }, data: { agentManaged: true, agentConsentOnlyResolution: config.program.consentOnlyResolution } });
    if (updated.count === 1) await appendEvent(tx, { caseId: caseRow.id, type: "AGENT_ENROLLED", actorId: input.actorId, payload: { origin: "case_manager", consentOnlyResolution: config.program.consentOnlyResolution } });
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
    // The assigned case manager, or else the program's case-manager queue.
    const recipients = row.caseManagerId
      ? [{ id: row.caseManagerId, locale: row.caseManager?.locale ?? "fr-CA" }]
      : await tx.user.findMany({ where: { globalRole: "CASE_MANAGER", credentials: { some: {} } }, select: { id: true, locale: true } });
    for (const user of recipients) {
      await tx.notification.create({ data: { userId: user.id, caseId, kind: "agent_escalated", locale: user.locale } });
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

/**
 * A case manager from the queue takes an escalated case that no one is
 * assigned to. Declaring no conflict of interest is part of taking it.
 */
export async function claimEscalatedCase(input: { actorId: string; actorRole: GlobalRole; caseId: string; hasConflict: boolean }): Promise<Outcome> {
  if (input.actorRole !== "CASE_MANAGER") return { ok: false, status: 404, reason: "Case not found." };
  const row = await prisma.case.findUnique({ where: { id: input.caseId } });
  if (!row || !row.agentEscalatedAt || row.caseManagerId || row.state === "CLOSED") return { ok: false, status: 404, reason: "Case not found." };
  if (input.hasConflict) return { ok: false, status: 409, reason: "A case manager with a conflict of interest cannot take this case." };
  const taken = await prisma.$transaction(async (tx) => {
    const updated = await tx.case.updateMany({ where: { id: row.id, caseManagerId: null, agentEscalatedAt: { not: null } }, data: { caseManagerId: input.actorId } });
    if (updated.count !== 1) return false;
    await tx.coiDeclaration.create({ data: { caseId: row.id, caseManagerId: input.actorId, hasConflict: false } });
    await appendEvent(tx, { caseId: row.id, type: "COI_DECLARED", actorId: input.actorId, payload: { hasConflict: false } });
    await appendEvent(tx, { caseId: row.id, type: "CASE_ASSIGNED", actorId: input.actorId, payload: { caseManagerId: input.actorId, origin: "agent_escalation" } });
    return true;
  });
  return taken ? { ok: true } : { ok: false, status: 409, reason: "Another case manager took this case." };
}

/**
 * A party ends their participation. The complainant always may (existing
 * withdraw rule). The respondent may on an agent-managed case only when the
 * program's configured rule allows it; otherwise they decline or ask for a person.
 */
export async function endParticipation(input: { actorId: string; actorRole: GlobalRole; caseId: string }, env: Env = process.env): Promise<Outcome> {
  const row = await prisma.case.findUnique({ where: { id: input.caseId }, include: { complainant: { select: { locale: true } } } });
  if (!row) return { ok: false, status: 404, reason: "Case not found." };
  if (input.actorRole === "COMPLAINANT" && row.complainantId === input.actorId) {
    const { withdrawCase } = await import("../mutate");
    const result = await withdrawCase(input);
    return result.ok ? { ok: true } : { ok: false, status: result.step === "not-found" ? 404 : 409, reason: result.reason };
  }
  if (input.actorRole !== "RESPONDENT" || row.respondentId !== input.actorId) return { ok: false, status: 404, reason: "Case not found." };
  const program = caseAgentProgram(env);
  if (!row.agentManaged || !program.ok || !program.program.respondentMayWithdraw) {
    return { ok: false, status: 409, reason: "The program does not let the respondent end participation here. You can decline or ask for a person." };
  }
  const result = await runMutation({
    trigger: "respondent_withdraw",
    actorId: input.actorId,
    actorRole: input.actorRole,
    fromState: row.state,
    guardContexts: { isCaseParty: { actorId: input.actorId, complainantId: row.complainantId, respondentId: row.respondentId } },
    write: async (tx) => {
      const locked = await tx.case.updateMany({ where: { id: row.id, state: row.state }, data: { state: "WITHDRAWN" } });
      if (locked.count !== 1) throw new StaleAgentWrite();
      return {
        caseId: row.id, toState: "WITHDRAWN",
        eventPayloads: [{ type: "CASE_WITHDRAWN", payload: { by: "respondent" } }],
        notifications: [{ userId: row.complainantId, kind: "case_withdrawn", locale: row.complainant.locale }],
      };
    },
  }).catch((error) => {
    if (error instanceof StaleAgentWrite) return { ok: false as const, step: "guard" as const, reason: "The case changed. Reload and try again." };
    throw error;
  });
  return result.ok ? { ok: true } : { ok: false, status: result.step === "not-found" ? 404 : 409, reason: result.reason };
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
  mimeType: string;
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
export async function runCaseAgent(input: { caseId: string; model: TextCompletion | null; env?: Env; now?: Date }): Promise<AgentRunResult> {
  const env = input.env ?? process.env;
  const now = input.now ?? new Date();
  const config = caseAgentProgram(env);
  const agent = await loadCaseAgentAccount();
  if (!agent) return { status: "skipped", reason: "agent_account_missing" };
  const current = await prisma.case.findUnique({ where: { id: input.caseId }, select: { id: true, state: true, agentManaged: true, agentEscalatedAt: true } });
  if (!current) return { status: "skipped", reason: "case_missing" };
  if (current.agentEscalatedAt) return { status: "skipped", reason: "escalated" };
  const escalate = async (reason: EscalationReason): Promise<AgentRunResult> => {
    await escalateCase(current.id, agent.id, reason);
    return { status: "escalated", reason };
  };
  if (!config.ok) return current.agentManaged ? escalate("program_rules_incomplete") : { status: "skipped", reason: "program_rules_incomplete" };
  const program = config.program;
  if (current.state === "OPEN" && !current.agentManaged) {
    if (!input.model) return { status: "skipped", reason: "model_unavailable" };
    return takeCase(current.id, agent.id, program);
  }
  if (!current.agentManaged) return { status: "skipped", reason: "not_enrolled" };
  const first = await loadMaterial(input.caseId);
  const row = first.caseRow;
  if (row.agentEscalatedAt) return { status: "skipped", reason: "escalated" };
  const since = async (type: "EVIDENCE_INTAKE_OPENED" | "EVIDENCE_INTAKE_CLOSED" | "RECOMMENDATION_ISSUED") => {
    const event = await prisma.event.findFirst({ where: { caseId: row.id, type }, orderBy: { seq: "desc" }, select: { createdAt: true } });
    return event ? now.getTime() - event.createdAt.getTime() : 0;
  };
  const responseWindow = program.responseDays * DAY_MS;

  switch (row.state) {
    case "EVIDENCE_INTAKE":
      return intakeStep(row.id, agent.id, program, now, escalate, await since("EVIDENCE_INTAKE_OPENED"));
    case "POSITIONS":
      if ((!first.complainantPosition || !first.respondentPosition) && await since("EVIDENCE_INTAKE_CLOSED") > responseWindow) return escalate("submission_missing");
      break;
    case "ISSUED":
      if (first.openContestations > 0) return escalate("contestation_open");
      return await since("RECOMMENDATION_ISSUED") > responseWindow ? escalate("no_answer") : { status: "waiting", reason: "awaiting_answers" };
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
  if (row.amountAtStakeCents === null || row.amountAtStakeCents > program.maxAmountCents) return escalate("out_of_scope_amount");
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
      mimeType: item.mimeType,
      sourceSha256: item.sha256,
      extractedTextSha256: createHash("sha256").update(extraction.text).digest("hex"),
    });
  }

  const digest = materialDigest(first, evidenceSources);
  let raw: string;
  try {
    const prompt = buildCaseAgentPrompt(first, evidenceSources);
    if (input.model.completeWithJsonSchema) {
      raw = (await input.model.completeWithJsonSchema(prompt, AGENT_OUTPUT_JSON_SCHEMA)).text;
    } else {
      raw = await input.model.complete(prompt);
    }
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
        ...(source.mimeType === "application/pdf" ? { page: source.text.slice(0, start).split("\f").length } : {}),
      },
    };
  });
  const explanation: ExplanationRecord = {
    summary: out.summary_claims.map((claim) => claim.text).join(" "),
    proposed_outcome: `Structured proposal: ${out.proposal.remedy}${out.proposal.amount_cents !== null ? ` (${out.proposal.amount_cents} CAD cents)` : ""}. Each party received fixed wording in their language.`,
    reasoning: out.reasoning_claims.map((claim) => claim.text).join(" "),
    evidence_citations: evidenceCitations,
    claim_evidence: [
      ...out.summary_claims.map((claim) => ({ section: "summary" as const, ...claim })),
      ...out.reasoning_claims.map((claim) => ({ section: "reasoning" as const, ...claim })),
    ],
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
        for (const [partyId, locale, role, evidenceItemIds] of [
          [row.complainantId, row.complainant.locale, "complainant", out.party_evidence.complainant],
          [row.respondentId, row.respondent.locale, "respondent", out.party_evidence.respondent],
        ] as const) {
          // Fixed wording only: no model-written sentence reaches a party.
          const body = renderProposal(out.proposal, row.amountAtStakeCents!, role, locale);
          const partyEvidenceIds = new Set(evidenceItemIds);
          const citationPointers: PartyOutcomeCitationPointer[] = evidenceCitations
            .filter((citation) => partyEvidenceIds.has(citation.evidence_item_id))
            .map((citation) => ({
              evidenceItemId: citation.evidence_item_id,
              // Staff read this note; readPartyOutcomes withholds it from parties.
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
  const caseRecord = await tx.case.findUniqueOrThrow({ where: { id: caseId } });
  // Keep relation reads explicit and sequential on the transaction-bound
  // client. Prisma's query strategy can otherwise issue the included relation
  // reads concurrently over the same pg Client connection.
  const complainant = await tx.user.findUniqueOrThrow({ where: { id: caseRecord.complainantId }, select: { id: true, locale: true } });
  const respondent = await tx.user.findUniqueOrThrow({ where: { id: caseRecord.respondentId }, select: { id: true, locale: true } });
  const evidenceItems = await tx.evidenceItem.findMany({ where: { caseId }, orderBy: { createdAt: "asc" } });
  const chronologyEntries = await tx.chronologyEntry.findMany({ where: { caseId }, orderBy: [{ occurredOn: "asc" }, { createdAt: "asc" }] });
  const caseRow = { ...caseRecord, complainant, respondent, evidenceItems, chronologyEntries };
  const latestPosition = (partyId: string) => tx.positionStatement.findFirst({ where: { caseId, partyId }, orderBy: { version: "desc" } });
  // Transaction clients share one PostgreSQL connection; overlapping queries
  // on that client are deprecated by pg and are serialized internally anyway.
  const complainantPosition = await latestPosition(caseRow.complainantId);
  const respondentPosition = await latestPosition(caseRow.respondentId);
  const openContestations = await tx.contestation.count({ where: { caseId, status: "OPEN" } });
  const superseded = new Set(caseRow.evidenceItems.map((e) => e.supersedesId).filter(Boolean));
  return { caseRow, complainantPosition, respondentPosition, openContestations, current: caseRow.evidenceItems.filter((e) => !superseded.has(e.id)) };
}

/**
 * Take an eligible, unassigned, submitted case and open intake. Ineligible
 * cases are left untouched for the case-manager queue that already sees
 * open cases. Both parties are told the assistant handles routine steps.
 */
async function takeCase(caseId: string, agentId: string, program: CaseAgentProgram): Promise<AgentRunResult> {
  const row = await prisma.case.findUniqueOrThrow({ where: { id: caseId }, include: { complainant: { select: { locale: true } }, respondent: { select: { locale: true } } } });
  if (row.caseManagerId) return { status: "skipped", reason: "assigned_to_person" };
  if (row.category !== "RETAIL") return { status: "skipped", reason: "out_of_scope_category" };
  if (row.amountAtStakeCents === null || row.amountAtStakeCents > program.maxAmountCents) return { status: "skipped", reason: "out_of_scope_amount" };
  const result = await runMutation({
    trigger: "agent_open_intake",
    actorId: agentId,
    actorRole: "CASE_AGENT",
    fromState: row.state,
    guardContexts: { agentMayAct: { agentManaged: true, escalated: false, actorIsCaseAgent: true } },
    write: async (tx) => {
      const locked = await tx.case.updateMany({ where: { id: caseId, state: "OPEN", caseManagerId: null, agentManaged: false, agentEscalatedAt: null }, data: { state: "EVIDENCE_INTAKE", agentManaged: true, agentConsentOnlyResolution: program.consentOnlyResolution } });
      if (locked.count !== 1) throw new StaleAgentWrite();
      return {
        caseId, toState: "EVIDENCE_INTAKE",
        eventPayloads: [
          { type: "AGENT_ENROLLED", payload: { origin: "program_rules", consentOnlyResolution: program.consentOnlyResolution } },
          { type: "EVIDENCE_INTAKE_OPENED", payload: { origin: "case_agent" } },
        ],
        notifications: [
          { userId: row.complainantId, kind: "agent_managing", locale: row.complainant.locale },
          { userId: row.respondentId, kind: "agent_managing", locale: row.respondent.locale },
        ],
      };
    },
  }).catch((error) => { if (error instanceof StaleAgentWrite) return null; throw error; });
  if (!result) return { status: "stale" };
  return result.ok ? { status: "intake_opened" } : { status: "waiting", reason: result.reason };
}

/** Invite the respondent, watch the response and evidence periods, then close intake. */
async function intakeStep(
  caseId: string, agentId: string, program: CaseAgentProgram, now: Date,
  escalate: (reason: EscalationReason) => Promise<AgentRunResult>, intakeAgeMs: number,
): Promise<AgentRunResult> {
  const row = await prisma.case.findUniqueOrThrow({
    where: { id: caseId },
    include: {
      complainant: { select: { locale: true } },
      respondent: { select: { locale: true, _count: { select: { credentials: true } } } },
      evidenceItems: true,
    },
  });
  if (row.respondent._count.credentials === 0) {
    const latest = await prisma.invitation.findFirst({ where: { userId: row.respondentId, revokedAt: null, claimedAt: null }, orderBy: { createdAt: "desc" } });
    if (latest) {
      // Provider acceptance can succeed while saving emailedAt fails. Keep
      // that token valid and hand the uncertain delivery state to a person;
      // creating another invitation could revoke a link already in the inbox.
      if (!latest.emailedAt) return escalate("invitation_failed");
      return now.getTime() - latest.emailedAt!.getTime() > program.responseDays * DAY_MS ? escalate("respondent_no_response") : { status: "waiting", reason: "respondent_invited" };
    }
    return inviteRespondent(caseId, agentId, program, escalate);
  }
  const superseded = new Set(row.evidenceItems.map((e) => e.supersedesId).filter(Boolean));
  const current = row.evidenceItems.filter((e) => !superseded.has(e.id));
  const periodExpired = intakeAgeMs > program.intakeDays * DAY_MS;
  if (current.some((e) => e.scanStatus === "PENDING")) {
    return periodExpired ? escalate("evidence_scan_pending") : { status: "waiting", reason: "scan_pending" };
  }
  if (current.some((e) => e.scanStatus === "REJECTED")) return escalate("evidence_rejected");
  const has = (partyId: string) => current.some((e) => e.submittedById === partyId && e.scanStatus === "CLEAN");
  if (!has(row.complainantId) || !has(row.respondentId)) {
    return periodExpired ? escalate("submission_missing") : { status: "waiting", reason: "evidence_submission_open" };
  }
  const bothReady = Boolean(row.complainantIntakeReadyAt && row.respondentIntakeReadyAt);
  if (!bothReady) {
    return periodExpired
      ? escalate("intake_incomplete")
      : { status: "waiting", reason: "parties_completing_intake" };
  }
  const result = await runMutation({
    trigger: "agent_close_intake",
    actorId: agentId,
    actorRole: "CASE_AGENT",
    fromState: row.state,
    guardContexts: {
      agentMayAct: { agentManaged: row.agentManaged, escalated: Boolean(row.agentEscalatedAt), actorIsCaseAgent: true },
      bothPartiesMarkedIntakeReady: { complainantReady: Boolean(row.complainantIntakeReadyAt), respondentReady: Boolean(row.respondentIntakeReadyAt) },
      atLeastOneEvidenceItemPerPartyOrOverride: { complainantHasEvidence: true, respondentHasEvidence: true },
    },
    write: async (tx) => {
      const locked = await tx.case.updateMany({
        where: {
          id: caseId, state: "EVIDENCE_INTAKE", agentManaged: true, agentEscalatedAt: null,
          complainantIntakeReadyAt: row.complainantIntakeReadyAt,
          respondentIntakeReadyAt: row.respondentIntakeReadyAt,
        },
        data: { state: "POSITIONS" },
      });
      if (locked.count !== 1) throw new StaleAgentWrite();
      return {
        caseId,
        toState: "POSITIONS",
        eventPayloads: [{ type: "EVIDENCE_INTAKE_CLOSED", payload: { origin: "case_agent" } }],
        notifications: [
          { userId: row.complainantId, kind: CASE_AGENT_POSITIONS_REQUESTED_KIND, locale: row.complainant.locale },
          { userId: row.respondentId, kind: CASE_AGENT_POSITIONS_REQUESTED_KIND, locale: row.respondent.locale },
        ],
      };
    },
  }).catch((error) => { if (error instanceof StaleAgentWrite) return null; throw error; });
  if (!result) return { status: "stale" };
  return result.ok ? { status: "intake_closed" } : { status: "waiting", reason: result.reason };
}

/** The existing respondent invitation, sent once, under the case-row lock. */
async function inviteRespondent(caseId: string, agentId: string, program: CaseAgentProgram, escalate: (reason: EscalationReason) => Promise<AgentRunResult>): Promise<AgentRunResult> {
  if (!emailConfigured()) return escalate("invitation_failed");
  const prepared = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Case" WHERE id = ${caseId} FOR UPDATE`;
    const row = await tx.case.findUniqueOrThrow({ where: { id: caseId }, include: { respondent: { include: { _count: { select: { credentials: true } } } } } });
    if (row.state !== "EVIDENCE_INTAKE" || row.agentEscalatedAt || row.respondent._count.credentials > 0) return null;
    const active = await tx.invitation.findFirst({ where: { userId: row.respondentId, revokedAt: null, claimedAt: null } });
    if (active) return null;
    const { token, expiresAt } = issueInviteToken(row.respondentId, program.responseDays * DAY_MS / 1000);
    await tx.invitation.updateMany({ where: { userId: row.respondentId, revokedAt: null, claimedAt: null }, data: { revokedAt: new Date() } });
    const invitation = await tx.invitation.create({ data: { userId: row.respondentId, tokenHash: invitationTokenHash(token), issuedById: agentId, locale: row.respondent.locale, expiresAt } });
    await appendEvent(tx, { caseId, type: "PARTY_NOTIFIED", actorId: agentId, payload: { kind: "respondent_invitation", invitationId: invitation.id } });
    return { email: row.respondent.email, locale: row.respondent.locale, token, invitationId: invitation.id };
  });
  if (!prepared) return { status: "waiting", reason: "respondent_invited" };
  try {
    const delivery = await sendInvitationEmail({ email: prepared.email, locale: prepared.locale, claimPath: invitePath(prepared.locale, prepared.token), invitationId: prepared.invitationId, validForDays: program.responseDays });
    if (delivery !== "accepted") throw new Error("not accepted");
  } catch (error) {
    if (!(error instanceof EmailDeliveryError) || error.certainty === "rejected") {
      await revokeInvitation(prepared.invitationId).catch(() => {});
    }
    return escalate("invitation_failed");
  }
  return { status: "respondent_invited" };
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
