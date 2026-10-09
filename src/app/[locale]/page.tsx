import Image from "next/image";
import Link from "next/link";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { EvenLine, Wordmark } from "../../components/icons";
import styles from "./landing.module.css";

/**
 * Public entry to the locale-aware workspace. The root route also resolves
 * here through next.config.mjs; case data stays behind the existing sign-in.
 */
export default async function LandingPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("landing");
  const steps = ["evidence", "review", "consent"] as const;

  return (
    <div className={styles.page} lang={locale}>
      <main id="landing-content" className={styles.content}>
        <section className={`${styles.hero} ${styles.panel}`} aria-labelledby="landing-title">
          <div className={styles.heroCopy}>
            <p className={styles.productLabel}>{t("workspaceLabel")}</p>
            <h1 id="landing-title" className={styles.headline}>{t("tagline")}</h1>
            <EvenLine />
            <p className={styles.intro}>{t("intro")}</p>
            <div className={styles.actions}>
              <Link className={styles.primaryAction} href={`/${locale}/auth/sign-in`}>
                {t("signIn")}<span aria-hidden="true">→</span>
              </Link>
              <Link className={styles.secondaryAction} href={`/${locale}/cases`}>
                {t("myCases")}<span aria-hidden="true">↗</span>
              </Link>
            </div>
          </div>

          <figure className={styles.heroVisual}>
            <div className={styles.imageFrame}>
              <Image
                className={styles.heroImage}
                src="/images/shared-record.webp"
                alt=""
                fill
                sizes="(max-width: 767px) calc(100vw - 40px), (max-width: 1023px) 43vw, 520px"
                preload
              />
            </div>
            <figcaption className={styles.imageCaption}>{t("imageCaption")}</figcaption>
          </figure>
        </section>

        <div className={styles.lower}>
        <section className={`${styles.submissions} ${styles.panel}`} aria-labelledby="submissions-title">
          <h2 id="submissions-title">{t("submissions.title")}</h2>
          <p>{t("submissions.path")}</p>
          <dl className={styles.submissionGuide}>
            {(["evidence", "chronology", "position"] as const).map(kind => <div key={kind}>
              <dt>{t(`submissions.${kind}.title`)}</dt>
              <dd>{t(`submissions.${kind}.description`)}</dd>
            </div>)}
          </dl>
          <p className={styles.submissionNote}>{t("submissions.note")}</p>
        </section>

        <section className={`${styles.process} ${styles.panel}`} aria-labelledby="process-title">
          <div className={styles.processIntroduction}>
            <h2 id="process-title">{t("processTitle")}</h2>
            <p>{t("lead")}</p>
          </div>
          <ol className={styles.steps}>
            {steps.map((step, index) => (
              <li className={styles.step} key={step}>
                <span className={styles.stepNumber} aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
                <div>
                  <h3>{t(`steps.${step}.title`)}</h3>
                  <p>{t(`steps.${step}.description`)}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>
        </div>
      </main>

      <footer className={styles.footer}>
        <span className={styles.footerBrand}><Wordmark>{t("title")}</Wordmark></span>
        <p>{t("footer")}</p>
      </footer>
    </div>
  );
}
