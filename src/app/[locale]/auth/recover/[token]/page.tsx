import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { resolveAccountRecovery } from "../../../../../lib/accountRecovery";
import RecoveryPasskeyForm from "./RecoveryPasskeyForm";
import styles from "../../../../auth/sign-in/sign-in.module.css";

export default async function RecoverTokenPage({ params }: { params: Promise<{ locale: string; token: string }> }) {
  const { locale, token } = await params;
  const t = await getTranslations("recovery");
  const recovery = await resolveAccountRecovery(token);
  return <main className={styles.page}><div className={styles.frame}><div className={styles.card}>
    <h1>{t("replaceTitle")}</h1>
    {recovery ? <><p>{t("replaceDescription")}</p><RecoveryPasskeyForm token={token} locale={locale} /></> : <p role="alert">{t("invalid")}</p>}
    <p><Link href={`/${locale}/auth/sign-in`}>{t("backToSignIn")}</Link></p>
  </div></div></main>;
}
