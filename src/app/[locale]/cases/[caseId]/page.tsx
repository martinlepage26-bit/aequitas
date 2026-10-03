import ReviewDraftForm from "./ReviewDraftForm";
import ConflictKnowledgeView from "./ConflictKnowledgeView";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getSession } from "../../../../lib/session";
import { prisma } from "../../../../lib/prisma";
import { getAuthorityView, type AuthorityActionKey, type AuthorityRoleKey, type CaseProgress } from "../../../../domain/authorityView";
import { filterEventsForRole } from "../../../../domain/eventTimeline";
import { caseReadAccess } from "../../../../domain/caseAccess";
import type { ExplanationRecord } from "../../../../domain/explanationRecord";
import { resolveRoleTerm } from "../../../../i18n/categoryGlossary";
import EvidenceForm from "./EvidenceForm";
import PositionForm from "./PositionForm";
import CloseIntakeButton from "./CloseIntakeButton";
import SubmitCaseButton from "./SubmitCaseButton";
import OpenIntakeButton from "./OpenIntakeButton";
import RequestDraftButton from "./RequestDraftButton";
import IssueRecommendationForm from "./IssueRecommendationForm";
import ConsentPanel from "./ConsentPanel";
import WithdrawButton from "./WithdrawButton";
import CloseCaseButton from "./CloseCaseButton";
import ChronologyForm from "./ChronologyForm";
import { formatChronologyDate } from "../../../../domain/chronology";
import { submissionAvailability, type SubmissionKind } from "../../../../domain/submissionView";
import styles from "./workspace.module.css";

export default async function CaseWorkspacePage({ params }: { params: Promise<{ locale: string; caseId: string }> }) {
  const { caseId, locale } = await params;
  const session = await getSession();
  if (!session) redirect("/auth/sign-in");

  const caseRow = await prisma.case.findUnique({
    where: { id: caseId },
    include: {
      complainant: { select: { id: true, displayName: true } },
      respondent: { select: { id: true, displayName: true } },
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
  const consentStateFor = (partyId: string) => consentRecords.find((c) => c.partyId === partyId)?.state ?? "NOT_GIVEN";

  // Section 16 RBAC-404 posture, applied to page access: a viewer with no
  // read access sees "not found", never a 403 that would confirm the case
  // exists. H2: a case manager other than the assigned one reaches this page
  // only while the case is OPEN and unclaimed, to self-claim via open_intake
  // (see src/domain/caseAccess.ts).
  const access = caseReadAccess(caseRow, session);
  if (!access) notFound();

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
      recommendation = { id: row.id, explanation: row.explanation as unknown as ExplanationRecord, status: row.status };
    }
  }
  const reviewer = recommendation?.explanation.reviewer.user_id
    ? await prisma.user.findUnique({ where: { id: recommendation.explanation.reviewer.user_id }, select: { displayName: true } })
    : null;

  const visibleEvents = filterEventsForRole(caseRow.events, session.globalRole, access === "assigned-manager");
  const eventActorIds = [...new Set(visibleEvents.map((e) => e.actorId))];
  const eventActors = eventActorIds.length
    ? await prisma.user.findMany({ where: { id: { in: eventActorIds } }, select: { id: true, displayName: true } })
    : [];
  const eventActorNameById = new Map(eventActors.map((a) => [a.id, a.displayName]));
  const dateFormatter = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  const isParty = session.userId === caseRow.complainantId || session.userId === caseRow.respondentId;
  const submissions = ["evidence", "chronology", "position"] as const;
  const guidance = (kind: SubmissionKind) => t(`submission.availability.${submissionAvailability(kind, caseRow.state, isParty)}`);
  const target = (kind: SubmissionKind) => kind === "position" ? "positions-heading" : `${kind}-heading`;

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

      <h2 id="submission-heading">{t("submission.title")}</h2>
      <p>{t("submission.description")}</p>
      <nav className={styles.submissionNav} aria-labelledby="submission-heading">
        {submissions.map(kind => <a key={kind} className={styles.submissionLink} href={`#${target(kind)}`}>
          <strong>{t(`submission.actions.${kind}`)}</strong>
          <span>{guidance(kind)}</span>
        </a>)}
      </nav>

      <section aria-labelledby="authority-heading" style={{ border: "1px solid #ccc", padding: "1rem", marginBottom: "1.5rem" }}>
        <h2 id="authority-heading" style={{ fontSize: "1rem", marginTop: 0 }}>
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

      <section aria-labelledby="evidence-heading" className={styles.section}>
        <h2 id="evidence-heading">{t("evidence.title")}</h2>
        <p>{t("submission.evidenceHelp")}</p>
        <p className={styles.guidance} id="evidence-guidance">{guidance("evidence")}</p>
        {caseRow.evidenceItems.length === 0 ? (
          <p>{t("evidence.empty")}</p>
        ) : (
          <ul>
            {caseRow.evidenceItems
              .filter((e) => e.scanStatus !== "REJECTED" || e.submittedById === session.userId)
              .map((e) => (
                <li key={e.id} id={`evidence-${e.id}`}>
                  <strong>{e.title}</strong> ({t(`evidence.kind.${e.kind}`)}) — {t("evidence.submittedBy", { name: e.submittedBy.displayName })}
                  {" — "}
                  {t(`evidence.scanStatus.${e.scanStatus}`)}
                  {caseRow.evidenceItems.some((other) => other.supersedesId === e.id) && <> — {t("evidence.supersededNotice")}</>}
                </li>
              ))}
          </ul>
        )}
        <EvidenceForm caseId={caseId} disabled={!canSubmitEvidence || !isParty} />
      </section>

      <section aria-labelledby="chronology-heading" className={styles.section}>
        <h2 id="chronology-heading">{t("chronology.title")}</h2>
        <p>{t("chronology.description")}</p>
        <p className={styles.guidance} id="chronology-guidance">{guidance("chronology")}</p>
        {caseRow.chronologyEntries.length === 0 ? <p>{t("chronology.empty")}</p> : <ol className={styles.chronology}>
          {caseRow.chronologyEntries.map(entry => <li key={entry.id} id={`chronology-${entry.id}`}>
            <time dateTime={entry.occurredOn.toISOString().slice(0, 10)}>{formatChronologyDate(entry.occurredOn, locale)}</time>
            <div>
              <h3 lang={entry.locale}>{entry.title}</h3>
              <p lang={entry.locale}>{entry.description}</p>
              <p className={styles.hint}>{t("chronology.reportedBy", { name: entry.submittedBy.displayName })}</p>
            </div>
          </li>)}
        </ol>}
        <ChronologyForm caseId={caseId} disabled={!canSubmitChronology || !isParty} />
      </section>

      <section aria-labelledby="positions-heading" className={styles.section}>
        <h2 id="positions-heading">{t("positions.title")}</h2>
        <p>{t("submission.positionHelp")}</p>
        <p className={styles.guidance} id="position-guidance">{guidance("position")}</p>
        {caseRow.positionStatements.length === 0 ? (
          <p>{t("positions.empty")}</p>
        ) : (
          <ul>
            {caseRow.positionStatements.map((p) => (
              <li key={p.id}>
                <strong>{p.party.displayName}</strong> — {t("positions.version", { version: p.version })}
                <p className={styles.recordText}>{p.body}</p>
              </li>
            ))}
          </ul>
        )}
        <PositionForm caseId={caseId} disabled={!canSubmitPosition || !isParty} />
      </section>

      {canCloseIntake && <CloseIntakeButton caseId={caseId} />}
      {canRequestDraft && <RequestDraftButton caseId={caseId} />}

      {recommendation && (
        <section aria-labelledby="recommendation-heading" style={{ marginBottom: "1.5rem", marginTop: "1.5rem" }}>
          <h2 id="recommendation-heading">{t("recommendation.title")}</h2>
          <h3 style={{ fontSize: "1rem" }}>
            {recommendation.status === "ISSUED" ? t("recommendation.issuedHeading") : t("recommendation.draftHeading")}
          </h3>
          <p>
            <strong>{t("recommendation.summaryLabel")}:</strong> {recommendation.explanation.summary}
          </p>
          <p>
            <strong>{t("recommendation.proposedOutcomeLabel")}:</strong> {recommendation.explanation.proposed_outcome}
          </p>
          <p>
            <strong>{t("recommendation.reasoningLabel")}:</strong> {recommendation.explanation.reasoning}
          </p>
          <p>
            <strong>{t("recommendation.citationsLabel")}:</strong>
          </p>
          <ul>
            {recommendation.explanation.evidence_citations.map((c) => (
              <li key={c.evidence_item_id}>
                <a href={`#evidence-${c.evidence_item_id}`}>{c.relevance}</a>
              </li>
            ))}
          </ul>
          <p>
            <strong>{t("recommendation.limitsLabel")}:</strong>
          </p>
          <ul>
            {recommendation.explanation.limits.map((limit, i) => (
              <li key={i}>{limit}</li>
            ))}
          </ul>
          <p>
            <strong>{t("recommendation.notConsideredLabel")}:</strong>
          </p>
          <ul>
            {recommendation.explanation.not_considered.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
          <p className={styles.hint}>
            {t("recommendation.modelLabel", { model: recommendation.explanation.model.id, version: recommendation.explanation.model.prompt_version })}
          </p>
          {reviewer && (
            <p className={styles.hint}>{t("recommendation.reviewerLabel", { name: reviewer.displayName })}</p>
          )}
          {recommendation.explanation.conflict_knowledge && <ConflictKnowledgeView map={recommendation.explanation.conflict_knowledge} sources={recommendation.explanation.knowledge_sources ?? []} />}
          {canIssueRecommendation && recommendation.status === "DRAFT" && recommendation.explanation.conflict_knowledge && <ReviewDraftForm key={`review-${recommendation.id}`} caseId={caseId} recommendationId={recommendation.id} explanation={recommendation.explanation} />}
          {canIssueRecommendation && recommendation.status === "DRAFT" && <IssueRecommendationForm key={`issue-${recommendation.id}`} recommendationId={recommendation.id} />}
        </section>
      )}

      {(canGiveOrDeclineConsent || canRevokeConsent) && currentStatement && (
        <ConsentPanel
          caseId={caseId}
          statementVersionId={currentStatement.id}
          statementBody={currentStatement.body}
          ownConsentState={ownConsentState}
        />
      )}

      {canCloseCase && <CloseCaseButton caseId={caseId} />}

      {caseRow.state === "CLOSED" && (
        <p style={{ marginTop: "1rem" }}>
          <a href={`/api/cases/${caseId}/export`}>{t("export.link")}</a>
        </p>
      )}

      <section aria-labelledby="timeline-heading" style={{ marginTop: "1.5rem" }}>
        <h2 id="timeline-heading">{t("timeline.title")}</h2>
        <p>{t("timeline.description")}</p>
        {visibleEvents.length === 0 ? (
          <p>{t("timeline.empty")}</p>
        ) : (
          <ol style={{ paddingLeft: "1.25rem" }}>
            {visibleEvents.map((e) => (
              <li key={e.id}>
                <time dateTime={e.createdAt.toISOString()}>{dateFormatter.format(e.createdAt)}</time>
                {" — "}
                {t(`timeline.event.${e.type}`)}
                {eventActorNameById.get(e.actorId) && <> {t("timeline.by", { name: eventActorNameById.get(e.actorId)! })}</>}
              </li>
            ))}
          </ol>
        )}
      </section>
    </main>
  );
}
