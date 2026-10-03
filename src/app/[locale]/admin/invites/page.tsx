import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getSession } from "../../../../lib/session";
import { signInPath } from "../../../../lib/authPaths";
import { prisma } from "../../../../lib/prisma";
import { emailConfigured } from "../../../../lib/mail";
import InviteManager from "./InviteManager";
import styles from "./invites.module.css";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "adminInvites" });
  return { title: `${t("title")} · Aequitas` };
}

export default async function InvitationsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const session = await getSession();
  if (!session) redirect(signInPath(locale, `/${locale}/admin/invites`));
  if (session.globalRole !== "ADMIN") notFound();
  const invitations = await prisma.invitation.findMany({ orderBy: { createdAt: "desc" }, take: 100, select: { id: true, expiresAt: true, revokedAt: true, claimedAt: true, emailedAt: true, user: { select: { email: true, displayName: true, globalRole: true } } } });
  const t = await getTranslations("adminInvites");
  return <main className={styles.page}><h1>{t("title")}</h1><p>{t("explain")}</p><InviteManager invitations={invitations.map(item => ({ ...item, expiresAt: item.expiresAt.toISOString(), revokedAt: item.revokedAt?.toISOString() ?? null, claimedAt: item.claimedAt?.toISOString() ?? null, emailedAt: item.emailedAt?.toISOString() ?? null }))} emailReady={emailConfigured()} /></main>;
}
