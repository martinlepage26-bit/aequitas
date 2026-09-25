import Link from "next/link";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { routing } from "../../i18n/routing";

/**
 * Locale landing (H7): /fr-CA and /en-CA. `/` redirects here (next.config.mjs)
 * instead of serving the retired M0 SQLite demo (H6).
 */
export default async function LandingPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("landing");
  const otherLocale = routing.locales.find((l) => l !== locale) ?? routing.defaultLocale;

  return (
    <main lang={locale} style={{ maxWidth: "40rem", margin: "4rem auto", padding: "0 1rem", fontFamily: "system-ui, sans-serif", lineHeight: 1.5 }}>
      <h1 style={{ marginBottom: "0.25rem" }}>{t("title")}</h1>
      <p style={{ marginTop: 0, color: "#555" }}>{t("tagline")}</p>
      <p>{t("lead")}</p>
      <ul style={{ listStyle: "none", padding: 0, display: "flex", gap: "1.5rem", flexWrap: "wrap" }}>
        <li>
          <Link href="/auth/sign-in">{t("signIn")}</Link>
        </li>
        <li>
          <Link href={`/${locale}/cases`}>{t("myCases")}</Link>
        </li>
        <li>
          <Link href={`/${otherLocale}`} hrefLang={otherLocale} lang={otherLocale}>
            {t("otherLocale")}
          </Link>
        </li>
      </ul>
    </main>
  );
}
