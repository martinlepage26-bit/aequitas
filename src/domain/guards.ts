/**
 * Guards — aequitas-implementation-handoff.md Section 4: "Guards live in
 * one place... implements every guard in the state machine table (Section
 * 6) as a pure function returning { ok: true } | { ok: false, reason }."
 *
 * Guards never touch the database. The mutation pipeline fetches whatever
 * data a guard needs and passes it in as a plain argument.
 */

export type GuardResult = { ok: true } | { ok: false; reason: string; code?: string };

const OK: GuardResult = { ok: true };
function fail(reason: string): GuardResult {
  return { ok: false, reason };
}

// --- create_case -----------------------------------------------------

export function authenticated(ctx: { actorId: string | null }): GuardResult {
  return ctx.actorId ? OK : fail("Not authenticated.");
}

export function statementVersionsCurrent(ctx: { requestedVersionId: string; currentVersionId: string }): GuardResult {
  return ctx.requestedVersionId === ctx.currentVersionId
    ? OK
    : fail("The consent statement version has changed; reload before proceeding.");
}

// --- submit_case / withdraw -------------------------------------------

export function isCaseOwner(ctx: { actorId: string; complainantId: string }): GuardResult {
  return ctx.actorId === ctx.complainantId ? OK : fail("Only the complainant who owns this case may perform this action.");
}

export function requiredIntakeFieldsComplete(ctx: { missingFields: string[] }): GuardResult {
  return ctx.missingFields.length === 0
    ? OK
    : fail(`Required intake fields are missing: ${ctx.missingFields.join(", ")}`);
}

// --- open_intake / close_intake / request_draft / issue_recommendation /
//     request_new_version / close_case ---------------------------------

export function caseAssignedToManager(ctx: { actorId: string; caseManagerId: string | null }): GuardResult {
  if (!ctx.caseManagerId) return fail("This case has no assigned case manager.");
  return ctx.actorId === ctx.caseManagerId ? OK : fail("Only the case's assigned case manager may perform this action.");
}

/**
 * open_intake only: Section 16 defines no case-assignment endpoint, so a
 * case manager claims an unassigned case by calling open_intake itself.
 * Unlike caseAssignedToManager, this allows a null caseManagerId through —
 * the mutation then assigns it to the acting manager in the same
 * transaction. A case already claimed by someone else still blocks.
 */
export function caseAssignedToManagerOrUnclaimed(ctx: { actorId: string; caseManagerId: string | null }): GuardResult {
  if (ctx.caseManagerId === null) return OK;
  return ctx.actorId === ctx.caseManagerId
    ? OK
    : fail("This case is already assigned to a different case manager.");
}

export function coiDeclarationOnFile(ctx: { declared: boolean; hasConflict: boolean }): GuardResult {
  if (!ctx.declared) return fail("A conflict-of-interest declaration must be on file first.");
  if (ctx.hasConflict) return fail("A declared conflict of interest prevents this case manager from proceeding on this case.");
  return OK;
}

// --- submit_evidence / supersede_evidence / submit_position / give_consent /
//     decline_consent -----------------------------------------------------

export function isCaseParty(ctx: { actorId: string; complainantId: string; respondentId: string }): GuardResult {
  return ctx.actorId === ctx.complainantId || ctx.actorId === ctx.respondentId
    ? OK
    : fail("Only a party to this case may perform this action.");
}

export function evidenceVisibilityRequiresCleanScan(_ctx: Record<string, never>): GuardResult {
  // Submission always succeeds and starts PENDING (Section 11); this guard
  // documents that the *projection* layer, not this transition, is what
  // withholds a PENDING/REJECTED item from the other party and from AI
  // citation. It never blocks submit_evidence itself.
  return OK;
}

export function supersedesOwnItem(ctx: { actorId: string; priorItemSubmittedById: string }): GuardResult {
  return ctx.actorId === ctx.priorItemSubmittedById
    ? OK
    : fail("An evidence item can only be superseded by the party who submitted it.");
}

export function atLeastOneEvidenceItemPerPartyOrOverride(ctx: {
  complainantHasEvidence: boolean;
  respondentHasEvidence: boolean;
  overrideReason?: string;
}): GuardResult {
  if (ctx.complainantHasEvidence && ctx.respondentHasEvidence) return OK;
  if (ctx.overrideReason && ctx.overrideReason.trim().length > 0) return OK;
  return fail("Both parties must have at least one evidence item, or the case manager must record an override reason.");
}

export function oneCurrentVersionPerParty(_ctx: Record<string, never>): GuardResult {
  // Descriptive invariant, not a precondition: submitting a position always
  // creates a new version for that party; there is no failure mode here.
  return OK;
}

export function bothPartiesHaveCurrentPositions(ctx: { complainantHasPosition: boolean; respondentHasPosition: boolean }): GuardResult {
  return ctx.complainantHasPosition && ctx.respondentHasPosition
    ? OK
    : fail("Both parties must have submitted a current position before a draft can be requested.");
}

// --- draft_completed / issue_recommendation -----------------------------

export function explanationRecordValidatesAgainstSchema(ctx: { schemaValidationError: string | null }): GuardResult {
  return ctx.schemaValidationError === null ? OK : fail(`Explanation record failed schema validation: ${ctx.schemaValidationError}`);
}

export function explanationRecordValid(ctx: { schemaValidationError: string | null }): GuardResult {
  return explanationRecordValidatesAgainstSchema(ctx);
}

export function citationsResolveToCaseEvidence(ctx: {
  citedEvidenceItemIds: string[];
  caseEvidenceItemIds: Set<string>;
}): GuardResult {
  const unresolved = ctx.citedEvidenceItemIds.filter((id) => !ctx.caseEvidenceItemIds.has(id));
  return unresolved.length === 0
    ? OK
    : fail(`Recommendation cites evidence not in this case: ${unresolved.join(", ")}`);
}

export function reviewerIsIssuingManager(ctx: { actorId: string; caseManagerId: string | null }): GuardResult {
  return caseAssignedToManager(ctx as { actorId: string; caseManagerId: string | null });
}

// --- give_consent --------------------------------------------------------

export function consentBindsToCurrentRecommendationVersion(ctx: {
  targetRecommendationId: string;
  currentRecommendationId: string | null;
}): GuardResult {
  return ctx.targetRecommendationId === ctx.currentRecommendationId
    ? OK
    : fail("Consent must be given on the case's current recommendation version.");
}

export function statementVersionIsCurrent(ctx: { requestedVersionId: string; currentVersionId: string }): GuardResult {
  return statementVersionsCurrent(ctx);
}

// --- revoke_consent --------------------------------------------------------

export function isConsentingParty(ctx: { actorId: string; consentPartyId: string }): GuardResult {
  return ctx.actorId === ctx.consentPartyId ? OK : fail("Only the party who gave this consent may revoke it.");
}

export function caseNotClosed(ctx: { state: string }): GuardResult {
  return ctx.state !== "CLOSED" ? OK : fail("This case is closed.");
}

// --- request_new_version ----------------------------------------------

export function newVersionNumber(ctx: { requestedVersion: number; currentMaxVersion: number }): GuardResult {
  return ctx.requestedVersion === ctx.currentMaxVersion + 1
    ? OK
    : fail(`Expected version ${ctx.currentMaxVersion + 1}, got ${ctx.requestedVersion}.`);
}

export function priorRecommendationSuperseded(ctx: { priorRecommendationStatus: string }): GuardResult {
  // This guard describes an effect of the transition (the mutation pipeline
  // marks the prior recommendation SUPERSEDED in the same transaction), not
  // a precondition — it always passes as a documented no-op check.
  return ctx.priorRecommendationStatus !== "SUPERSEDED" ? OK : fail("The prior recommendation is already superseded.");
}

// --- close_case ----------------------------------------------------------

export function exportBundleGeneratedAndHashed(ctx: { exportSha256: string | null }): GuardResult {
  return ctx.exportSha256 ? OK : fail("An export bundle must be generated and hashed before closing the case.");
}

/**
 * Every guard name referenced in stateMachine.ts's TRANSITIONS table must
 * resolve here. Looked up by name so the mutation pipeline (and the
 * exhaustive unit test) can drive guards generically from the table.
 */
// --- give_consent: phase 3 resolution guards ----------------------------

/**
 * Phase 3: an open contestation, or a missing approver sign-off on a case
 * that is not consent-only, blocks the consent that would resolve it.
 * The blocker list is computed by src/domain/resolution.ts.
 */
export function resolutionNotBlocked(ctx: { blockers: Array<{ code: string; reason: string }> }): GuardResult {
  const first = ctx.blockers[0];
  return first ? { ok: false, reason: first.reason, code: first.code } : OK;
}

export const GUARD_REGISTRY: Record<string, (ctx: any) => GuardResult> = {
  authenticated,
  statementVersionsCurrent,
  isCaseOwner,
  requiredIntakeFieldsComplete,
  caseAssignedToManager,
  caseAssignedToManagerOrUnclaimed,
  coiDeclarationOnFile,
  isCaseParty,
  evidenceVisibilityRequiresCleanScan,
  supersedesOwnItem,
  atLeastOneEvidenceItemPerPartyOrOverride,
  oneCurrentVersionPerParty,
  bothPartiesHaveCurrentPositions,
  explanationRecordValidatesAgainstSchema,
  explanationRecordValid,
  citationsResolveToCaseEvidence,
  reviewerIsIssuingManager,
  consentBindsToCurrentRecommendationVersion,
  statementVersionIsCurrent,
  isConsentingParty,
  caseNotClosed,
  newVersionNumber,
  priorRecommendationSuperseded,
  exportBundleGeneratedAndHashed,
  resolutionNotBlocked,
};
