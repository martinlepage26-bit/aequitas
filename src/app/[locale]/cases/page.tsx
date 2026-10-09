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

  // Every branch includes both parties and reads whichever isn't the
  // viewer's own role, so the row-rendering below needs no per-role casts.
  const include = { complainant: { select: { displayName: true } }, respondent: { select: { displayName: true } } } as const;
  const cases =
    session.globalRole === "COMPLAINANT"
      ? await prisma.case.findMany({ where: { complainantId: session.userId }, include, orderBy: { createdAt: "desc" } })
      : session.globalRole === "RESPONDENT"
        ? await prisma.case.findMany({ where: { respondentId: session.userId }, include, orderBy: { createdAt: "desc" } })
        : await prisma.case.findMany({
            // H2: unclaimed cases are listed only while OPEN, the one state
            // in which another manager may open them (src/domain/caseAccess.ts).
            where: { OR: [{ caseManagerId: session.userId }, { caseManagerId: null, state: "OPEN" }] },
            include,
            orderBy: { createdAt: "desc" },
          });

  const rows = cases.map((c) => {
    const otherPartyName = session.globalRole === "COMPLAINANT" ? c.respondent.displayName : c.complainant.displayName;
    return {
      id: c.id,
      referenceNumber: c.referenceNumber,
      state: c.state,
      stateLabel: tState(c.state),
      detail: session.globalRole === "CASE_MANAGER" && c.caseManagerId === null ? t("unclaimed") : t("otherParty", { name: otherPartyName }),
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
    </main>
  );
}
