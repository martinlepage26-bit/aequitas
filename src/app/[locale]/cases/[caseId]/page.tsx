import { recordStaffAccess } from "../../../../domain/staffAccess";
import { signInPath } from "../../../../lib/authPaths";
import ReviewDraftForm from "./ReviewDraftForm";
import ConflictKnowledgeView from "./ConflictKnowledgeView";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getSession } from "../../../../lib/session";
import { prisma } from "../../../../lib/prisma";
import { getAuthorityView, type AuthorityActionKey, type AuthorityRoleKey, type CaseProgress } from "../../../../domain/authorityView";
import { visibleCaseEvents } from "../../../../domain/eventTimeline";
import { caseReadAccess } from "../../../../domain/caseAccess";
import { canReadPartySubmission, filterExplanationForParty } from "../../../../domain/submissionVisibility";
import { caseDetailsEditable } from "../../../../domain/caseDetails";
import type { ExplanationRecord } from "../../../../domain/explanationRecord";
import type { GlobalRole } from "../../../../generated/prisma";
import { DISPUTE_CATEGORIES, resolveCategoryLabel, resolveRoleTerm } from "../../../../i18n/categoryGlossary";
import CaseDetailsEditor from "./CaseDetailsEditor";
import RespondentInviteButton from "./RespondentInviteButton";
import EvidenceForm from "./EvidenceForm";
import PositionForm from "./PositionForm";
import CloseIntakeButton from "./CloseIntakeButton";
import SubmitCaseButton from "./SubmitCaseButton";
import OpenIntakeButton from "./OpenIntakeButton";
import RequestDraftButton from "./RequestDraftButton";
import AuthorDraftForm from "./AuthorDraftForm";
import CaseAgentPanel from "./CaseAgentPanel";
import IntakeReadyButton from "./IntakeReadyButton";
import { caseAgentEnabled } from "../../../../domain/caseAgent/agent";
import { caseAgentProgram } from "../../../../domain/caseAgent/config";
import { processingConsentMatches } from "../../../../domain/caseAgent/processingConsent";

function caseAgentRespondentMayWithdraw(): boolean {
  const program = caseAgentProgram();
  return program.ok && program.program.respondentMayWithdraw;
}
import { isHumanAuthoredModel } from "../../../../domain/humanAuthored";
import IssueRecommendationForm from "./IssueRecommendationForm";
import ConsentPanel from "./ConsentPanel";
import PartyOutcomePanel from "./PartyOutcomePanel";
import PartyOutcomeCitations from "./PartyOutcomeCitations";
import WithdrawButton from "./WithdrawButton";
import CloseCaseButton from "./CloseCaseButton";
import ChronologyForm from "./ChronologyForm";
import ClaimsPanel from "./ClaimsPanel";
import PipelinePanel from "./PipelinePanel";
import ResolutionPanel, { type ContestTargetOption } from "./ResolutionPanel";
import { readResolutionView } from "../../../../domain/resolution";
import { readPartyOutcomes } from "../../../../domain/partyOutcome";
import { freeModelConfigured } from "../../../../domain/pipeline/provider";
import { pipelineEnabled } from "../../../../domain/pipeline/flag";
import { readPipeline } from "../../../../domain/pipeline/writes";
import { readClaimGraph } from "../../../../domain/claimWrites";
import { formatChronologyDate } from "../../../../domain/chronology";
import { submissionAvailability, type SubmissionKind } from "../../../../domain/submissionView";
import styles from "./workspace.module.css";
import CaseJourney from "./CaseJourney";
import CaseActivity from "./CaseActivity";

export default async function CaseWorkspacePage({ params }: { params: Promise<{ locale: string; caseId: string }> }) {
  const { caseId, locale } = await params;
  const session = await getSession();
  if (!session) redirect(signInPath(locale, `/${locale}/cases/${caseId}`));

  const caseRow = await prisma.case.findUnique({
    where: { id: caseId },
    include: {
      complainant: { select: { id: true, displayName: true } },
      respondent: { select: { id: true, displayName: true, email: true } },
      caseManager: { select: { id: true, displayName: true } },
      evidenceItems: { orderBy: { createdAt: "asc" }, include: { submittedBy: { select: { displayName: true } } } },
      positionStatements: { orderBy: [{ partyId: "asc" }, { version: "asc" }], include: { party: { select: { displayName: true } } } },
      chronologyEntries: { orderBy: [{ occurredOn: "asc" }, { createdAt: "asc" }, { id: "asc" }], include: { submittedBy: { select: { displayName: true } } } },
      events: { orderBy: { seq: "asc" } },
    },
  });
  if (!caseRow) notFound();

  const consentRecords = caseRow.currentRecommendationId
    ? await prisma.consentRecord.findMany({ where: { recommendationId: caseRow.currentRecommendationId } })
    : [];
  const issuedOutcomes = await prisma.partyOutcome.findMany({
    where: { caseId, status: "ISSUED" },
    orderBy: [{ partyId: "asc" }, { version: "desc" }],
  });
  const currentIssuedFor = (partyId: string) => issuedOutcomes.find((outcome) => outcome.partyId === partyId) ?? null;
  const consentStateFor = (partyId: string) => {
    const record = consentRecords.find((entry) => entry.partyId === partyId);
    const current = currentIssuedFor(partyId);
    if (!record || !current || record.partyOutcomeId !== current.id || record.partyOutcomeVersion !== current.version) return "NOT_GIVEN" as const;
    return record.state;
  };

  // Section 16 RBAC-404 posture, applied to page access: a viewer with no
  // read access sees "not found", never a 403 that would confirm the case
  // exists. H2: a case manager other than the assigned one reaches this page
  // only while the case is OPEN and unclaimed, to self-claim via open_intake
  // (see src/domain/caseAccess.ts).
  // Phase 3: an approver (User.isApprover) gets a party-level read of cases
  // they do not own, so they can sign off or overrule.
  const viewerFlags = await prisma.user.findUnique({ where: { id: session.userId }, select: { isApprover: true } });
  const viewer = { ...session, isApprover: viewerFlags?.isApprover ?? false };
  const access = caseReadAccess(caseRow, viewer);
  if (!access) notFound();
  await recordStaffAccess(caseId, session, "workspace");

  const agentProgram = caseAgentProgram();
  const viewerIsParty = session.userId === caseRow.complainantId || session.userId === caseRow.respondentId;
  const latestOwnProcessingChoice = viewerIsParty
    ? [...caseRow.events].reverse().find((event) => event.type === "AGENT_PROCESSING_ACCEPTED" && event.actorId === session.userId)
    : undefined;
  const processingChoice = caseRow.agentManaged && caseRow.state === "POSITIONS" && access === "party" && viewerIsParty && agentProgram.ok
    ? {
        providerName: agentProgram.program.processingDisclosure.providerName,
        accountOrProjectId: agentProgram.program.processingDisclosure.accountOrProjectId,
        modelName: agentProgram.program.processingDisclosure.modelName,
        notice: locale === "fr-CA" ? agentProgram.program.processingDisclosure.noticeFr : agentProgram.program.processingDisclosure.noticeEn,
        noticeHash: agentProgram.program.processingDisclosure.noticeHash,
        locale: locale === "fr-CA" ? "fr-CA" as const : "en-CA" as const,
        accepted: Boolean(latestOwnProcessingChoice && processingConsentMatches(latestOwnProcessingChoice.payload, agentProgram.program.processingDisclosure)),
      }
    : null;

  const visibleEvidence = caseRow.evidenceItems.filter((item) =>
    canReadPartySubmission({ access, viewerId: session.userId, authorId: item.submittedById }),
  );
  const visiblePositions = caseRow.positionStatements.filter((item) =>
    canReadPartySubmission({ access, viewerId: session.userId, authorId: item.partyId }),
  );
  const visibleChronology = caseRow.chronologyEntries.filter((entry) =>
    canReadPartySubmission({ access, viewerId: session.userId, authorId: entry.submittedById }),
  );

  const progress: CaseProgress = {
    complainantHasCleanEvidence: caseRow.evidenceItems.some((e) => e.submittedById === caseRow.complainantId && e.scanStatus === "CLEAN"),
    respondentHasCleanEvidence: caseRow.evidenceItems.some(
      (e) => e.submittedById === caseRow.respondentId && e.scanStatus === "CLEAN"
    ),
    complainantHasCurrentPosition: caseRow.positionStatements.some((p) => p.partyId === caseRow.complainantId),
    respondentHasCurrentPosition: caseRow.positionStatements.some((p) => p.partyId === caseRow.respondentId),
    complainantConsentState: consentStateFor(caseRow.complainantId),
    respondentConsentState: consentStateFor(caseRow.respondentId),
  };

  const authority = getAuthorityView(caseRow.state, session.globalRole, progress);

  const t = await getTranslations("workspace");
  const tBanner = await getTranslations("banner");

  const actionLabel = (key: AuthorityActionKey) => t(`action.${key}`);
  // Handoff 2026-08-15-070312 "Immediate Next Steps" #3: complainant/respondent
  // resolve through the case's category (e.g. "tenant"/"landlord" for
  // TENANCY) instead of the literal internal role name; every other role key
  // (caseManager, admin, bothParties, system) has no domain-specific term and
  // falls back to the static catalog.
  const roleLabel = (key: AuthorityRoleKey | "bothParties" | "system") =>
    key === "complainant" || key === "respondent" ? resolveRoleTerm(caseRow.category, key, locale) : t(`role.${key}` as Parameters<typeof t>[0]);

  const canSubmitCase = authority.actionKeys.includes("submitCase");
  const canOpenIntake = authority.actionKeys.includes("openIntake");
  const canSubmitEvidence = authority.actionKeys.includes("submitEvidence");
  const canSubmitPosition = authority.actionKeys.includes("submitPosition");
  const canSubmitChronology = authority.actionKeys.includes("submitChronology");
  const canCloseIntake = authority.actionKeys.includes("closeIntake");
  const canRequestDraft = authority.actionKeys.includes("requestDraft") || authority.actionKeys.includes("requestNewVersion");
  const canIssueRecommendation = authority.actionKeys.includes("issueRecommendation");
  const canGiveOrDeclineConsent = authority.actionKeys.includes("giveConsent");
  const canRevokeConsent = authority.actionKeys.includes("revokeConsent");
  const canWithdraw = authority.actionKeys.includes("withdraw") && caseRow.state !== "CLOSED";
  const canCloseCase = authority.actionKeys.includes("closeCase");

  const ownConsentState =
    session.userId === caseRow.complainantId
      ? progress.complainantConsentState
      : session.userId === caseRow.respondentId
        ? progress.respondentConsentState
        : "NOT_GIVEN";

  const currentStatement = await prisma.consentStatementVersion.findFirst({
    where: { locale },
    orderBy: { effectiveFrom: "desc" },
  });

  // Section 10: "View draft recommendation: never (consumer/retailer), yes
  // (case manager)". An ISSUED recommendation is a different story — every
  // party needs to see it to give informed consent (M4) — so quarantine
  // only applies while status is DRAFT.
  const isAssignedManager = session.globalRole === "CASE_MANAGER" && session.userId === caseRow.caseManagerId;
  let recommendation: { id: string; explanation: ExplanationRecord; status: string } | null = null;
  if (caseRow.currentRecommendationId) {
    const row = await prisma.recommendation.findUnique({ where: { id: caseRow.currentRecommendationId } });
    if (row && (row.status === "ISSUED" || isAssignedManager)) {
      const explanation = row.explanation as unknown as ExplanationRecord;
      const partyExplanation = access === "party"
        ? filterExplanationForParty(explanation, {
            evidenceIds: new Set(caseRow.evidenceItems.filter((item) => item.submittedById !== session.userId).map((item) => item.id)),
            positionIds: new Set(caseRow.positionStatements.filter((item) => item.partyId !== session.userId).map((item) => item.id)),
            chronologyIds: new Set(caseRow.chronologyEntries.filter((entry) => entry.submittedById !== session.userId).map((entry) => entry.id)),
          })
        : explanation;
      recommendation = { id: row.id, explanation: partyExplanation, status: row.status };
    }
  }
  const humanAuthored = recommendation ? isHumanAuthoredModel(recommendation.explanation.model.id) : false;
  // A party's copy omits the shared text when it may draw on the other
  // party's submissions (submissionVisibility). Say so instead of showing
  // empty fields; the party's own outcome is what they answer.
  const recommendationWithheld = access === "party" && recommendation !== null
    && !recommendation.explanation.summary && !recommendation.explanation.proposed_outcome && !recommendation.explanation.reasoning;
  const canAuthorDraft = isAssignedManager && canRequestDraft
    && (caseRow.state === "POSITIONS" || caseRow.state === "DRAFTING")
    && (!recommendation || recommendation.status === "DRAFT");
  const cleanEvidenceOptions = caseRow.evidenceItems
    .filter((e) => e.scanStatus === "CLEAN" && !caseRow.evidenceItems.some((other) => other.supersedesId === e.id))
    .map((e) => ({ id: e.id, title: e.title }));
  const reviewer = recommendation?.explanation.reviewer.user_id
    ? await prisma.user.findUnique({ where: { id: recommendation.explanation.reviewer.user_id }, select: { displayName: true } })
    : null;

  const visibleEvents = visibleCaseEvents(caseRow.events, { globalRole: session.globalRole, userId: session.userId, access });
  const eventActorIds = [...new Set(visibleEvents.map((e) => e.actorId))];
  const eventActors = eventActorIds.length
    ? await prisma.user.findMany({ where: { id: { in: eventActorIds } }, select: { id: true, displayName: true, globalRole: true } })
    : [];
  const eventActorNameById = new Map(eventActors.map((a) => [a.id, a.displayName]));
  const eventActorRoleById = new Map(eventActors.map((a) => [a.id, a.globalRole]));
  const isParty = session.userId === caseRow.complainantId || session.userId === caseRow.respondentId;
  const canEditDetails = session.globalRole === "COMPLAINANT" && session.userId === caseRow.complainantId && caseDetailsEditable(caseRow.state);
  const detailsRevision = canEditDetails ? await prisma.event.findFirst({ where: { caseId, type: "CASE_DETAILS_UPDATED" }, orderBy: { seq: "desc" }, select: { id: true } }) : null;
  const canManageInvite = canEditDetails && (caseRow.state === "OPEN" || caseRow.state === "EVIDENCE_INTAKE");
  const [respondentPasskeys, activeInvitation] = canManageInvite ? await Promise.all([
    prisma.webAuthnCredential.count({ where: { userId: caseRow.respondentId } }),
    prisma.invitation.findFirst({ where: { userId: caseRow.respondentId, revokedAt: null, claimedAt: null, expiresAt: { gt: new Date() } }, select: { emailedAt: true } }),
  ]) : [0, null];
  const partyRole = (userId: string): GlobalRole | null =>
    userId === caseRow.complainantId ? "COMPLAINANT" : userId === caseRow.respondentId ? "RESPONDENT" : null;
  const sourceRoleLabel = (role: GlobalRole) => t(`role.${role === "CASE_MANAGER" ? "caseManager" : role.toLowerCase()}` as Parameters<typeof t>[0]);
  const submissions = ["evidence", "chronology", "position"] as const;
  const guidance = (kind: SubmissionKind) => t(`submission.availability.${submissionAvailability(kind, caseRow.state, isParty)}`);
  const target = (kind: SubmissionKind) => kind === "position" ? "positions-heading" : `${kind}-heading`;
  const claimGraph = await readClaimGraph(caseId, viewer);
  const resolutionView = caseRow.state === "DRAFT" ? null : await readResolutionView(caseId, viewer);
  const partyOutcomes = await readPartyOutcomes(caseId, viewer);
  const ownIssuedOutcome = partyOutcomes?.parties.find((party) => party.partyId === session.userId)?.issued ?? null;
  const ownConsentRecord = consentRecords.find((record) => record.partyId === session.userId) ?? null;
  const outcomeNeedsAnswer = Boolean(
    ownIssuedOutcome && ownConsentRecord?.revokedReason === "outcome_reissued"
    && (ownConsentRecord.partyOutcomeId !== ownIssuedOutcome.id || ownConsentRecord.partyOutcomeVersion !== ownIssuedOutcome.version),
  );
  if (!claimGraph) notFound();
  const contestTargets: ContestTargetOption[] = [
    ...(recommendation && recommendation.status === "ISSUED" ? [{ type: "RECOMMENDATION" as const, id: recommendation.id, label: t("resolution.target.RECOMMENDATION") }] : []),
    ...claimGraph.claimOptions.map((claim) => ({
      type: "CLAIM" as const,
      id: claim.id,
      label: t("resolution.targetClaim", { text: claim.text.length > 80 ? `${claim.text.slice(0, 77)}...` : claim.text }),
    })),
  ];
  const pipelineView = pipelineEnabled() ? await readPipeline(caseId, viewer) : null;

  return (
    <main className={styles.workspace}>
      <a className={styles.backLink} href={`/${locale}/cases`}>{t("submission.backToCases")}</a>
      {caseRow.simulated && (
        <div role="note" className={styles.simulatedNote}>
          <strong aria-hidden="true">⚠</strong> {tBanner("simulated")}
        </div>
      )}

      <h1>{t("caseReference", { reference: caseRow.referenceNumber })}</h1>
      <p>
        <strong>{t(`state.${caseRow.state}`)}</strong>
      </p>
      <div className={styles.originLegend} role="group" aria-label={t("attribution.legend")}>
        {(["COMPLAINANT", "RESPONDENT", "CASE_MANAGER"] as const).map((role) => (
          <span key={role} className={styles.originRecord} data-origin={role}>
            <span className={styles.originLabel}>{sourceRoleLabel(role)}</span>
          </span>
        ))}
      </div>
      <div className={styles.balance} aria-label={t("journey.balanceLabel")}>
        <div className={styles.balanceParty} data-origin="COMPLAINANT"><span className={styles.balanceDot} aria-hidden="true" />{sourceRoleLabel("COMPLAINANT")}</div>
        <span className={styles.balanceLine} aria-hidden="true" />
        <div className={styles.balanceCenter}><span aria-hidden="true">↔</span>{t("journey.sharedRecord")}</div>
        <span className={styles.balanceLine} aria-hidden="true" />
        <div className={styles.balanceParty} data-origin="RESPONDENT"><span className={styles.balanceDot} aria-hidden="true" />{sourceRoleLabel("RESPONDENT")}</div>
        <p>{t("journey.balanceNote")}</p>
      </div>
      <CaseJourney state={caseRow.state} />

      <section aria-labelledby="dispute-heading" className={`${styles.section} ${styles.originRecord}`} data-origin="COMPLAINANT">
        <h2 id="dispute-heading">{t("dispute.title")}</h2>
        <p className={styles.originMeta}><span className={styles.originLabel}>{sourceRoleLabel("COMPLAINANT")}</span>{t("attribution.by", { name: caseRow.complainant.displayName })}</p>
        <p>{t("edit.respondentSummary", { name: caseRow.respondent.displayName, email: caseRow.respondent.email })}</p>
        <p>{t("edit.categorySummary", { category: resolveCategoryLabel(caseRow.category, locale) })}</p>
        {caseRow.disputeDescription ? (
          <p className={styles.recordText}>{caseRow.disputeDescription}</p>
        ) : (
          <p>{t("dispute.missing")}</p>
        )}
        {caseRow.amountAtStakeCents != null && (
          <p>
            {t("dispute.amount", {
              amount: new Intl.NumberFormat(locale, { style: "currency", currency: "CAD" }).format(caseRow.amountAtStakeCents / 100),
            })}
          </p>
        )}
        {canEditDetails && <CaseDetailsEditor key={detailsRevision?.id ?? "initial"} caseId={caseId} revision={detailsRevision?.id ?? null} category={caseRow.category} categoryOptions={DISPUTE_CATEGORIES.map(value => ({ value, label: resolveCategoryLabel(value, locale) }))} disputeDescription={caseRow.disputeDescription ?? ""} amountAtStakeCents={caseRow.amountAtStakeCents} respondentEmail={caseRow.respondent.email} respondentDisplayName={caseRow.respondent.displayName} simulated={caseRow.simulated} />}
      </section>

      {canManageInvite && (respondentPasskeys > 0 ? <p>{t("inviteRespondent.active")}</p> : <RespondentInviteButton key={caseRow.respondentId} caseId={caseId} email={caseRow.respondent.email} name={caseRow.respondent.displayName} alreadySent={Boolean(activeInvitation?.emailedAt)} deliveryUncertain={Boolean(activeInvitation && !activeInvitation.emailedAt)} />)}

      <h2 id="submission-heading">{t("submission.title")}</h2>
      <p>{t("submission.description")}</p>
      <nav className={styles.submissionNav} aria-labelledby="submission-heading">
        {submissions.map(kind => <a key={kind} className={styles.submissionLink} href={`#${target(kind)}`}>
          <strong>{t(`submission.actions.${kind}`)}</strong>
          <span>{guidance(kind)}</span>
        </a>)}
      </nav>

      <section aria-labelledby="authority-heading" className={styles.section}>
        <h2 id="authority-heading">
          {t("header.roleLabel", { role: roleLabel(authority.roleKey) })}
        </h2>
        {caseRow.state === "CLOSED" ? (
          <p>{t("header.closedNotice")}</p>
        ) : (
          <>
            <p>
              {authority.actionKeys.length > 0
                ? t("header.authorityPrefix", { actions: authority.actionKeys.map(actionLabel).join(", ") })
                : t("header.authorityNone")}
            </p>
            {authority.waitingOn && (
              <p>
                {t("header.waitingOnPrefix", {
                  role: roleLabel(authority.waitingOn.roleKey),
                  action: actionLabel(authority.waitingOn.actionKey as AuthorityActionKey),
                })}
              </p>
            )}
          </>
        )}
        {canSubmitCase && <SubmitCaseButton caseId={caseId} />}
        {canOpenIntake && <OpenIntakeButton caseId={caseId} />}
        {canWithdraw && <WithdrawButton caseId={caseId} />}
      </section>

      <section aria-labelledby="evidence-heading" className={`${styles.section} ${styles.tile}`}>
        <h2 id="evidence-heading">{t("evidence.title")}</h2>
        <p>{t("submission.evidenceHelp")}</p>
        <p className={styles.guidance} id="evidence-guidance">{guidance("evidence")}</p>
        {visibleEvidence.length === 0 ? (
          <p>{t("evidence.empty")}</p>
        ) : (
          <ul>
            {visibleEvidence
              .filter((e) => e.scanStatus !== "REJECTED" || e.submittedById === session.userId)
              .map((e) => (
                <li key={e.id} id={`evidence-${e.id}`} className={styles.originRecord} data-origin={partyRole(e.submittedById) ?? undefined}>
                  {partyRole(e.submittedById) && <span className={styles.originLabel}>{sourceRoleLabel(partyRole(e.submittedById)!)}</span>}{" "}
                  <strong>{e.title}</strong> ({t(`evidence.kind.${e.kind}`)}) — {t("evidence.submittedBy", { name: e.submittedBy.displayName })}
                  {" — "}
                  {t(`evidence.scanStatus.${e.scanStatus}`)}
                  {e.scanStatus === "CLEAN" && (isParty || isAssignedManager) && (
                    <>
                      {" — "}
                      <a href={`/api/cases/${caseId}/evidence/${e.id}`}>{t("evidence.download", { title: e.title })}</a>
                    </>
                  )}
                  {visibleEvidence.some((other) => other.supersedesId === e.id) && <> — {t("evidence.supersededNotice")}</>}
                </li>
              ))}
          </ul>
        )}
        <EvidenceForm caseId={caseId} disabled={!canSubmitEvidence || !isParty} />
      </section>

      <section aria-labelledby="chronology-heading" className={`${styles.section} ${styles.tile}`}>
        <h2 id="chronology-heading">{t("chronology.title")}</h2>
        <p>{t("chronology.description")}</p>
        <p className={styles.guidance} id="chronology-guidance">{guidance("chronology")}</p>
        {visibleChronology.length === 0 ? <p>{t("chronology.empty")}</p> : <ol className={styles.chronology}>
          {visibleChronology.map(entry => (
            <li key={entry.id} id={`chronology-${entry.id}`} className={styles.originRecord} data-origin={partyRole(entry.submittedById) ?? undefined}>
            <time dateTime={entry.occurredOn.toISOString().slice(0, 10)}>{formatChronologyDate(entry.occurredOn, locale)}</time>
            <div>
              {partyRole(entry.submittedById) && <p className={styles.originMeta}><span className={styles.originLabel}>{sourceRoleLabel(partyRole(entry.submittedById)!)}</span>{t("attribution.by", { name: entry.submittedBy.displayName })}</p>}
              <h3 lang={entry.locale}>{entry.title}</h3>
              <p lang={entry.locale}>{entry.description}</p>
              <p className={styles.hint}>{t("chronology.reportedBy", { name: entry.submittedBy.displayName })}</p>
            </div>
          </li>
          ))}
        </ol>}
        <ChronologyForm caseId={caseId} disabled={!canSubmitChronology || !isParty} />
        {isParty && caseRow.agentManaged && !caseRow.agentEscalatedAt && caseRow.state === "EVIDENCE_INTAKE" && (
          <IntakeReadyButton
            caseId={caseId}
            ready={session.userId === caseRow.complainantId
              ? Boolean(caseRow.complainantIntakeReadyAt)
              : Boolean(caseRow.respondentIntakeReadyAt)}
          />
        )}
      </section>

      <section aria-labelledby="positions-heading" className={`${styles.section} ${styles.tile}`}>
        <h2 id="positions-heading">{t("positions.title")}</h2>
        <p>{t("submission.positionHelp")}</p>
        <p className={styles.guidance} id="position-guidance">{guidance("position")}</p>
        {visiblePositions.length === 0 ? (
          <p>{t("positions.empty")}</p>
        ) : (
          <ul>
            {visiblePositions.map((p) => (
              <li key={p.id} className={styles.originRecord} data-origin={partyRole(p.partyId) ?? undefined}>
                {partyRole(p.partyId) && <span className={styles.originLabel}>{sourceRoleLabel(partyRole(p.partyId)!)}</span>}{" "}
                <strong>{p.party.displayName}</strong> — {t("positions.version", { version: p.version })}
                <p className={styles.recordText}>{p.body}</p>
              </li>
            ))}
          </ul>
        )}
        <PositionForm caseId={caseId} disabled={!canSubmitPosition || !isParty} />
      </section>

      <ClaimsPanel caseId={caseId} locale={locale} graph={claimGraph} complainantId={caseRow.complainantId} respondentId={caseRow.respondentId} />

      {pipelineEnabled() && pipelineView && (
        <PipelinePanel caseId={caseId} view={pipelineView} modelConfigured={freeModelConfigured()} />
      )}

      {canCloseIntake && <CloseIntakeButton caseId={caseId} />}
      {canRequestDraft && <RequestDraftButton caseId={caseId} />}
      {(access === "party" || access === "assigned-manager" || (access === "claimable" && caseRow.agentEscalatedAt)) && (
        <CaseAgentPanel
          caseId={caseId}
          viewer={access === "party" ? "party" : "manager"}
          agentManaged={caseRow.agentManaged}
          escalated={Boolean(caseRow.agentEscalatedAt)}
          escalationReason={access !== "party" ? caseRow.agentEscalationReason : null}
          canClaim={access === "claimable" && Boolean(caseRow.agentEscalatedAt)}
          canEndParticipation={access === "party" && caseRow.agentManaged && (session.userId === caseRow.complainantId || caseAgentRespondentMayWithdraw())}
          closed={caseRow.state === "CLOSED"}
          canEnroll={access === "assigned-manager" && !caseRow.agentManaged && caseAgentEnabled() && caseRow.category === "RETAIL" && (caseRow.state === "EVIDENCE_INTAKE" || caseRow.state === "POSITIONS")}
          processingChoice={processingChoice}
        />
      )}
      {canAuthorDraft && (
        <AuthorDraftForm
          key={`author-${recommendation?.id ?? "new"}`}
          caseId={caseId}
          evidence={cleanEvidenceOptions}
          replacesRecommendationId={recommendation?.id ?? null}
          initial={recommendation && humanAuthored ? recommendation.explanation : undefined}
        />
      )}

      {recommendation && (
        <section aria-labelledby="recommendation-heading" className={styles.section}>
          <h2 id="recommendation-heading">{t("recommendation.title")}</h2>
          <h3>
            {recommendation.status === "ISSUED" ? t("recommendation.issuedHeading") : t("recommendation.draftHeading")}
          </h3>
          {recommendationWithheld && <p id="recommendation-withheld" role="note">{t("recommendation.withheldForParty")}</p>}
          {recommendation.explanation.summary && (
            <p>
              <strong>{t("recommendation.summaryLabel")}:</strong> {recommendation.explanation.summary}
            </p>
          )}
          {recommendation.explanation.proposed_outcome && (
            <p>
              <strong>{t("recommendation.proposedOutcomeLabel")}:</strong> {recommendation.explanation.proposed_outcome}
            </p>
          )}
          {recommendation.explanation.reasoning && (
            <p>
              <strong>{t("recommendation.reasoningLabel")}:</strong> {recommendation.explanation.reasoning}
            </p>
          )}
          {recommendation.explanation.claim_evidence && recommendation.explanation.claim_evidence.length > 0 && (
            <>
              <p><strong>{t("recommendation.claimEvidenceLabel")}:</strong></p>
              <ul>
                {recommendation.explanation.claim_evidence.map((claim, index) => (
                  <li key={`${claim.section}-${index}`}>
                    {claim.section === "proposal" && <strong>{t("recommendation.proposalBasisLabel")}: </strong>}
                    {claim.text}
                    <ul>
                      {claim.citation_ids.map((citationId) => {
                        const citation = recommendation.explanation.evidence_citations.find((item) => item.citation_id === citationId);
                        if (!citation) return null;
                        const source = caseRow.evidenceItems.find((item) => item.id === citation.evidence_item_id);
                        return (
                          <li key={citationId}>
                            <a href={`#evidence-${citation.evidence_item_id}`}>
                              {source?.title ?? t("recommendation.citedEvidenceFallback")}
                            </a>
                            {citation.relevance ? ` — ${citation.relevance}` : ""}
                          </li>
                        );
                      })}
                    </ul>
                  </li>
                ))}
              </ul>
            </>
          )}
          {recommendation.explanation.evidence_citations.length > 0 && (
            <>
              <p>
                <strong>{t("recommendation.citationsLabel")}:</strong>
              </p>
              <ul>
                {recommendation.explanation.evidence_citations.map((c) => (
                  <li key={c.citation_id ?? c.evidence_item_id}>
                    <a href={`#evidence-${c.evidence_item_id}`}>
                      {c.relevance || caseRow.evidenceItems.find((e) => e.id === c.evidence_item_id)?.title || t("recommendation.citedEvidenceFallback")}
                    </a>
                  </li>
                ))}
              </ul>
            </>
          )}
          {recommendation.explanation.limits.length > 0 && (
            <>
              <p>
                <strong>{t("recommendation.limitsLabel")}:</strong>
              </p>
              <ul>
                {recommendation.explanation.limits.map((limit, i) => (
                  <li key={i}>{limit}</li>
                ))}
              </ul>
            </>
          )}
          {recommendation.explanation.not_considered.length > 0 && (
            <>
              <p>
                <strong>{t("recommendation.notConsideredLabel")}:</strong>
              </p>
              <ul>
                {recommendation.explanation.not_considered.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </>
          )}
          <p className={styles.hint}>
            {humanAuthored
              ? t("recommendation.humanAuthoredLabel")
              : t("recommendation.modelLabel", { model: recommendation.explanation.model.id, version: recommendation.explanation.model.prompt_version })}
          </p>
          {reviewer && (
            <p className={styles.hint}>{t("recommendation.reviewerLabel", { name: reviewer.displayName })}</p>
          )}
          {recommendation.explanation.conflict_knowledge && <ConflictKnowledgeView map={recommendation.explanation.conflict_knowledge} sources={recommendation.explanation.knowledge_sources ?? []} />}
          {canIssueRecommendation && recommendation.status === "DRAFT" && recommendation.explanation.conflict_knowledge && <ReviewDraftForm key={`review-${recommendation.id}`} caseId={caseId} recommendationId={recommendation.id} explanation={recommendation.explanation} />}
          {canIssueRecommendation && recommendation.status === "DRAFT" && <IssueRecommendationForm key={`issue-${recommendation.id}`} recommendationId={recommendation.id} />}
        </section>
      )}

      {partyOutcomes && access !== "party" && (partyOutcomes.canWrite || partyOutcomes.parties.some((party) => party.issued || party.draft)) && (
        <PartyOutcomePanel caseId={caseId} parties={partyOutcomes.parties} canWrite={partyOutcomes.canWrite} locale={locale} />
      )}

      {access === "party" && ownIssuedOutcome && (
        <section aria-labelledby="your-outcome-heading" className={styles.section}>
          <h2 id="your-outcome-heading">{t("partyOutcome.yourOutcome")}</h2>
          <p id="your-outcome">{ownIssuedOutcome.body}</p>
          <PartyOutcomeCitations caseId={caseId} outcomeId={ownIssuedOutcome.id} citations={ownIssuedOutcome.citations} />
        </section>
      )}

      {resolutionView && (
        <ResolutionPanel
          caseId={caseId}
          view={resolutionView}
          viewerId={session.userId}
          complainantId={caseRow.complainantId}
          respondentId={caseRow.respondentId}
          targets={contestTargets}
          sectionClassName={styles.section}
        />
      )}

      {(canGiveOrDeclineConsent || canRevokeConsent) && currentStatement && (
        <ConsentPanel
          caseId={caseId}
          statementVersionId={currentStatement.id}
          statementBody={currentStatement.body}
          ownConsentState={ownConsentState}
          outcomeIssued={Boolean(ownIssuedOutcome)}
          outcomeId={ownIssuedOutcome?.id ?? null}
          outcomeVersion={ownIssuedOutcome?.version ?? null}
          outcomeNeedsAnswer={outcomeNeedsAnswer}
        />
      )}

      {canCloseCase && <CloseCaseButton caseId={caseId} />}

      {caseRow.state === "CLOSED" && (
        <p>
          <a href={`/api/cases/${caseId}/export`}>{t("export.link")}</a>
        </p>
      )}

      <CaseActivity locale={locale} events={visibleEvents.map((event) => ({
        id: event.id,
        type: event.type,
        createdAt: event.createdAt.toISOString(),
        actorRole: (eventActorRoleById.get(event.actorId) ?? null) as "COMPLAINANT" | "RESPONDENT" | "CASE_MANAGER" | "ADMIN" | "CASE_AGENT" | null,
        actorName: eventActorNameById.get(event.actorId) ?? null,
      }))} />
    </main>
  );
}
