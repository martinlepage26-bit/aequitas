import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getSession } from "../../../lib/session";
import { prisma } from "../../../lib/prisma";

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
  if (!session) redirect("/auth/sign-in");

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

  return (
    <main style={{ maxWidth: "40rem", margin: "2rem auto", padding: "0 1rem", fontFamily: "system-ui, sans-serif" }}>
      <h1>{t("title")}</h1>
      {session.globalRole === "COMPLAINANT" && (
        <p>
          <a href={`/${locale}/cases/new`}>{t("startNew")}</a>
        </p>
      )}

      {cases.length === 0 ? (
        <p>{t("empty")}</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0 }}>
          {cases.map((c) => {
            const otherPartyName = session.globalRole === "COMPLAINANT" ? c.respondent.displayName : c.complainant.displayName;
            return (
              <li key={c.id} style={{ borderBottom: "1px solid #e2e8f0", padding: "0.75rem 0" }}>
                <strong>{c.referenceNumber}</strong> — {tState(c.state)}
                <br />
                {session.globalRole === "CASE_MANAGER" && c.caseManagerId === null ? (
                  <span>{t("unclaimed")} · </span>
                ) : (
                  <span>{t("otherParty", { name: otherPartyName })} · </span>
                )}
                <a href={`/${locale}/cases/${c.id}`}>{t("viewLink")}</a>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
