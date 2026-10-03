import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { getSession } from "../lib/session";
import styles from "./account-nav.module.css";

export default async function AccountNav({ locale }: { locale: string }) {
  const session = await getSession();
  if (!session) return null;
  const t = await getTranslations({ locale, namespace: "auth" });
  return <nav className={styles.nav} aria-label={t("account")}>
    <Link href={`/${locale}`}>Aequitas</Link>
    <Link href={`/${locale}/cases`}>{t("cases")}</Link>
    {session.globalRole === "ADMIN" && <Link href={`/${locale}/admin/invites`}>{t("invites")}</Link>}
    <form action="/api/auth/sign-out" method="post"><input type="hidden" name="locale" value={locale} /><button>{t("signOut")}</button></form>
  </nav>;
}
