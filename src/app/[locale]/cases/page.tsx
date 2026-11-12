import { signInPath } from "../../../lib/authPaths";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getSession } from "../../../lib/session";
import { prisma } from "../../../lib/prisma";
import CaseTable from "./CaseTable";

/**
 * The list/landing page for every role — see auth/sign-in/page.tsx's
 * landingPathFor. A CASE_MANAGER sees cases already assigned to them plus
 * unclaimed OPEN cases (caseManagerId: null): any case manager may open an
 * unclaimed OPEN case (Section 16 posture, also applied in
 * cases/[caseId]/page.tsx), and the first state-changing action they take
 * there claims it (see mutate.ts's openIntake). This page only surfaces
 * that; it doesn't need its own "claim" action.
 */
export default async function CaseListPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const session = await getSession();
  if (!session) redirect(signInPath(locale, `/${locale}/cases`));

  const t = await getTranslations("caseList");
  const tState = await getTranslations("workspace.state");
  const tDeletion = await getTranslations("deletionRequest");
  // Receipts are independent of erased case rows. Only the requester gets
  // this list; no case narrative, party names, or disposal evidence is read.
  const deletionRequests = await prisma.caseDeletion.findMany({
    where: { requestedById: session.userId },
    select: { id: true, caseId: true, status: true, requestedAt: true },
    orderBy: { requestedAt: "desc" },
  });
  const deletionStates = { REQUESTED: "requested", APPROVED: "approved", FROZEN: "frozen", ERASING: "erasing", LOCAL_PURGED: "localPurged", COMPLETED: "completed" } as const;

  // Every branch includes both parties and reads whichever isn't the
  // viewer's own role, so the row-rendering below needs no per-role casts.
  const include = { complainant: { select: { displayName: true } }, respondent: { select: { displayName: true } } } as const;
  const cases =
    session.globalRole === "COMPLAINANT"
      ? await prisma.case.findMany({ where: { deletionStartedAt: null, complainantId: session.userId }, include, orderBy: { createdAt: "desc" } })
      : session.globalRole === "RESPONDENT"
        ? await prisma.case.findMany({ where: { deletionStartedAt: null, respondentId: session.userId }, include, orderBy: { createdAt: "desc" } })
        : await prisma.case.findMany({
            // H2: unclaimed cases are listed only while OPEN, the one state
            // in which another manager may open them (src/domain/caseAccess.ts).
            where: { deletionStartedAt: null, OR: [{ caseManagerId: session.userId }, { caseManagerId: null, state: "OPEN" }, { caseManagerId: null, agentEscalatedAt: { not: null }, state: { not: "CLOSED" } }] },
            include,
            orderBy: { createdAt: "desc" },
          });

  // Any non-consent-only recommendation needs independent sign-off. Give only
  // a designated approver cases they can review, including cases owned by a
  // different case manager.
  const approverFlags = session.globalRole === "CASE_MANAGER"
    ? await prisma.user.findUnique({ where: { id: session.userId }, select: { isApprover: true } })
    : null;
  const approvalCandidates = approverFlags?.isApprover
    ? await prisma.case.findMany({
        where: {
          deletionStartedAt: null,
          state: "ISSUED",
          currentRecommendationId: { not: null },
          AND: [
            { OR: [
              { agentManaged: false, consentOnlyResolution: false },
              { agentManaged: true, agentConsentOnlyResolution: false },
              { agentManaged: true, agentEscalatedAt: { not: null } },
            ] },
            { OR: [{ caseManagerId: null }, { caseManagerId: { not: session.userId } }] },
          ],
        },
        include: {
          ...include,
          syntheses: { orderBy: { version: "desc" }, take: 1, select: { createdById: true } },
        },
        orderBy: { createdAt: "desc" },
      })
    : [];
  const recommendationIds = [...new Set(approvalCandidates.map((c) => c.currentRecommendationId).filter((id): id is string => Boolean(id)))];
  const currentRecommendations = recommendationIds.length
    ? await prisma.recommendation.findMany({
        where: { id: { in: recommendationIds } },
        select: { id: true, issuedById: true, status: true, reviews: { where: { action: "APPROVED" }, select: { id: true }, take: 1 } },
      })
    : [];
  const pendingRecommendationIds = new Set(currentRecommendations
    .filter((recommendation) => recommendation.status === "ISSUED" && recommendation.reviews.length === 0 && recommendation.issuedById !== session.userId)
    .map((recommendation) => recommendation.id));
  const pendingApprovalCases = approvalCandidates.filter((c) =>
    c.currentRecommendationId !== null
    && pendingRecommendationIds.has(c.currentRecommendationId)
    && c.syntheses[0]?.createdById !== session.userId,
  );
  const approvalCaseIds = new Set(pendingApprovalCases.map((c) => c.id));
  const visibleCases = [...cases, ...pendingApprovalCases].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  const rows = visibleCases.map((c) => {
    const otherPartyName = session.globalRole === "COMPLAINANT" ? c.respondent.displayName : c.complainant.displayName;
    return {
      id: c.id,
      referenceNumber: c.referenceNumber,
      state: c.state,
      stateLabel: tState(c.state),
      detail: approvalCaseIds.has(c.id)
        ? t("approvalNeeded")
        : session.globalRole === "CASE_MANAGER" && c.caseManagerId === null
          ? t("unclaimed")
          : t("otherParty", { name: otherPartyName }),
      href: `/${locale}/cases/${c.id}`,
    };
  });

  return (
    <main className="stack">
      <h1>{t("title")}</h1>
      {session.globalRole === "COMPLAINANT" && (
        <p>
          <a className="button-link" href={`/${locale}/cases/new`}>{t("startNew")}</a>
        </p>
      )}
      {rows.length === 0 ? <p className="panel">{t("empty")}</p> : <CaseTable rows={rows} />}
      {deletionRequests.length > 0 && (
        <section aria-labelledby="deletion-receipts-title" className="panel">
          <h2 id="deletion-receipts-title">{tDeletion("listTitle")}</h2>
          <ul>{deletionRequests.map(receipt => (
            <li key={receipt.id}>
              <a href={`/${locale}/cases/${receipt.caseId}/deletion`}>{tDeletion("statusLink")}</a>
              <p>{tDeletion("requestedOn")}: <time dateTime={receipt.requestedAt.toISOString()}>{receipt.requestedAt.toLocaleDateString(locale, { timeZone: "UTC", year: "numeric", month: "long", day: "numeric" })}</time></p>
              <p>{tDeletion(deletionStates[receipt.status])}</p>
            </li>
          ))}</ul>
        </section>
      )}
    </main>
  );
}
