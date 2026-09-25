import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { prisma } from "../../../../lib/prisma";
import { verifyInviteToken } from "../../../../lib/invite";
import ClaimInviteForm from "./ClaimInviteForm";

/**
 * Landing point of a single-use invitation link (C1/H1). The token is
 * checked again, authoritatively, by POST /api/auth/invite/claim; this page
 * only greets the invitee and says early when a link is dead.
 */
export default async function InvitePage({ params }: { params: Promise<{ locale: string; token: string }> }) {
  const { locale, token: rawToken } = await params;
  const token = decodeURIComponent(rawToken);
  const t = await getTranslations("invite");

  const userId = verifyInviteToken(token);
  const user = userId
    ? await prisma.user.findUnique({ where: { id: userId }, include: { _count: { select: { credentials: true } } } })
    : null;

  return (
    <main style={{ maxWidth: "32rem", margin: "3rem auto", padding: "0 1rem", fontFamily: "system-ui, sans-serif" }}>
      <h1>{t("title")}</h1>
      {!user ? (
        <p role="alert">{t("invalid")}</p>
      ) : user._count.credentials > 0 ? (
        <>
          <p>{t("alreadyClaimed")}</p>
          <p>
            <Link href="/auth/sign-in">{t("signInLink")}</Link>
          </p>
        </>
      ) : (
        <>
          <p>{t("greeting", { name: user.displayName, role: t(`role.${user.globalRole as "COMPLAINANT" | "RESPONDENT" | "CASE_MANAGER"}`) })}</p>
          <p>{t("explain")}</p>
          <ClaimInviteForm token={token} locale={locale} />
        </>
      )}
    </main>
  );
}
