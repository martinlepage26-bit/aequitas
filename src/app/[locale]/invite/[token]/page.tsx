import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { prisma } from "../../../../lib/prisma";
import { resolveInvitation } from "../../../../lib/invitations";
import styles from "../../../auth/sign-in/sign-in.module.css";
import ClaimInviteForm from "./ClaimInviteForm";

/**
 * Landing point of a single-use invitation link (C1/H1). The token is
 * checked again, authoritatively, by POST /api/auth/invite/claim; this page
 * only greets the invitee and says early when a link is dead.
 */
export default async function InvitePage({ params }: { params: Promise<{ locale: string; token: string }> }) {
  const { locale, token: rawToken } = await params;
  const token = rawToken; // Next has already decoded the route parameter.
  const t = await getTranslations("invite");

  const invitation = await resolveInvitation(token);
  const userId = invitation?.userId;
  const user = userId
    ? await prisma.user.findUnique({ where: { id: userId }, include: { _count: { select: { credentials: true } } } })
    : null;

  return (
    <main className={styles.page}><div className={styles.frame}><div className={styles.card}>
      <h1>{t("title")}</h1>
      {!user ? (
        <p role="alert">{t("invalid")}</p>
      ) : user._count.credentials > 0 ? (
        <>
          <p>{t("alreadyClaimed")}</p>
          <p>
            <Link href={`/${locale}/auth/sign-in`}>{t("signInLink")}</Link>
          </p>
        </>
      ) : (
        <>
          <p>{t("greeting", { name: user.displayName, role: t(`role.${user.globalRole as "COMPLAINANT" | "RESPONDENT" | "CASE_MANAGER"}`) })}</p>
          <p>{t("explain")}</p>
          <ClaimInviteForm token={token} locale={locale} />
        </>
      )}
      <p><Link href={`/${locale}`}>{t("home")}</Link></p>
    </div></div></main>
  );
}
