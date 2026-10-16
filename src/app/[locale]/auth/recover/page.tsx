import Link from "next/link";
import { getTranslations } from "next-intl/server";
import RecoveryRequestForm from "./RecoveryRequestForm";
import styles from "../../../auth/sign-in/sign-in.module.css";

export default async function RecoverPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations("recovery");
  return <main className={styles.page}><div className={styles.frame}><div className={styles.card}>
    <h1>{t("title")}</h1>
    <p>{t("requestDescription")}</p>
    <RecoveryRequestForm />
    <p><Link href={`/${locale}/auth/sign-in`}>{t("backToSignIn")}</Link></p>
  </div></div></main>;
}
