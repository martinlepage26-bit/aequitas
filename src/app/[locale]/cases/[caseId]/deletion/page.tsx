import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getSession } from "../../../../../lib/session";
import { signInPath } from "../../../../../lib/authPaths";
import { prisma } from "../../../../../lib/prisma";

/** This restricted receipt remains accessible to its requester after the
 * case itself is frozen or purged. No deleted content is fetched or shown. */
export default async function DeletionRequestPage({ params }: { params: Promise<{ caseId: string; locale: string }> }) {
  const { caseId, locale } = await params;
  const session = await getSession();
  if (!session) redirect(signInPath(locale, `/${locale}/cases/${caseId}/deletion`));
  const [job, c] = await Promise.all([
    prisma.caseDeletion.findUnique({ where: { caseId }, include: { copies: { select: { status: true } } } }),
    prisma.case.findUnique({ where: { id: caseId }, select: { complainantId: true, respondentId: true } }),
  ]);
  if (!job || !(session.globalRole === "ADMIN" || job.requestedById === session.userId || (c && [c.complainantId, c.respondentId].includes(session.userId)))) notFound();
  const t = await getTranslations("deletionRequest");
  const states = { REQUESTED: "requested", APPROVED: "approved", FROZEN: "frozen", ERASING: "erasing", LOCAL_PURGED: "localPurged", COMPLETED: "completed" } as const;
  return <main>
    <h1>{t("title")}</h1>
    <p>{t(states[job.status])}</p>
    <p>{t("reviewDate")}: <time dateTime={job.eligibleAt.toISOString()}>{job.eligibleAt.toLocaleDateString(locale, { timeZone: "UTC", year: "numeric", month: "long", day: "numeric" })}</time></p>
    {job.holdState !== "CLEAR" && <p>{t("hold")}</p>}
    {job.copies.some(copy => copy.status === "OUTSIDE_CONTROL") && <p>{t("outside")}</p>}
    <p>{t("account")}</p>
    <a href={`/${locale}/cases`}>{t("back")}</a>
  </main>;
}
