import Image from "next/image";
import Link from "next/link";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { renderProposal } from "../../../domain/caseAgent/proposal";
import { pilotContactUrl } from "../../../lib/pilotContact";
import styles from "./demo.module.css";

const AMOUNT_AT_STAKE_CENTS = 12_450;

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "caseDemo" });
  return { title: `${t("title")} · Aequitas`, description: t("metadata") };
}

/** A public, static explainer. Its only proposal text comes from the app's fixed template. */
export default async function CaseDemoPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("caseDemo");
  const pilotContact = pilotContactUrl();
  const amount = new Intl.NumberFormat(locale, { style: "currency", currency: "CAD" }).format(AMOUNT_AT_STAKE_CENTS / 100);
  const complainantProposal = renderProposal({ remedy: "replacement", amount_cents: null }, AMOUNT_AT_STAKE_CENTS, "complainant", locale);
  const respondentProposal = renderProposal({ remedy: "replacement", amount_cents: null }, AMOUNT_AT_STAKE_CENTS, "respondent", locale);
  const evidence = [
    { role: "complainant", position: "claim", item: "complainantEvidence" },
    { role: "respondent", position: "response", item: "respondentEvidence" },
  ] as const;
  const steps = ["intake", "evidence", "proposal", "choice"] as const;

  return (
    <main className={styles.page}>
      <section className={styles.hero} aria-labelledby="demo-title">
        <div className={styles.heroCopy}>
          <p className={styles.kicker}>{t("kicker")}</p>
          <h1 id="demo-title">{t("title")}</h1>
          <p className={styles.intro}>{t("intro")}</p>
          <div className={styles.actions}>
            <Link className={styles.primaryAction} href={`/${locale}/auth/sign-in`}>{t("signIn")}</Link>
            <Link className={styles.textAction} href={`/${locale}`}>{t("home")}</Link>
          </div>
        </div>
        <figure className={styles.visual}>
          <div className={styles.imageFrame}>
            <Image
              src="/images/shared-record.webp"
              alt=""
              fill
              sizes="(max-width: 760px) calc(100vw - 40px), 440px"
            />
          </div>
          <figcaption>{t("imageCaption")}</figcaption>
        </figure>
      </section>

      <aside className={styles.sampleNotice} role="note" aria-labelledby="sample-notice-title">
        <h2 id="sample-notice-title">{t("sampleNoticeTitle")}</h2>
        <p>{t("sampleNoticeBody")}</p>
      </aside>

      <section className={styles.caseSection} aria-labelledby="sample-case-title">
        <div className={styles.caseHeading}>
          <div>
            <h2 id="sample-case-title">{t("caseTitle")}</h2>
            <p>{t("caseDescription")}</p>
          </div>
          <p className={styles.amount}><span>{t("amountLabel")}</span><strong>{amount}</strong></p>
        </div>
      </section>

      <section className={styles.evidenceSection} aria-labelledby="evidence-title">
        <div className={styles.sectionHeading}>
          <h2 id="evidence-title">{t("evidenceTitle")}</h2>
        </div>
        <div className={styles.evidenceGrid}>
          {evidence.map(({ role, position, item }) => (
            <article className={styles.evidenceColumn} key={role}>
              <p className={styles.partyLabel}>{t(`party.${role}`)}</p>
              <h3>{t(`sample.${position}`)}</h3>
              <p className={styles.sourceLabel}>{t("evidenceLabel")}</p>
              <blockquote>{t(`sample.${item}`)}</blockquote>
            </article>
          ))}
        </div>
        <p className={styles.isolationNote}>{t("privacyNote")}</p>
      </section>

      <section className={styles.proposalSection} aria-labelledby="proposal-title">
        <div className={styles.sectionHeading}>
          <h2 id="proposal-title">{t("proposalTitle")}</h2>
          <p>{t("proposalDescription")}</p>
        </div>
        <div className={styles.proposalGrid}>
          <article>
            <h3>{t("party.complainant")}</h3>
            <p className={styles.proposalText}>{complainantProposal}</p>
            <p className={styles.citationNote}>{t("sample.complainantEvidence")}</p>
          </article>
          <article>
            <h3>{t("party.respondent")}</h3>
            <p className={styles.proposalText}>{respondentProposal}</p>
            <p className={styles.citationNote}>{t("sample.respondentEvidence")}</p>
          </article>
        </div>
      </section>

      <section className={styles.nextSection} aria-labelledby="next-title">
        <h2 id="next-title">{t("workflowTitle")}</h2>
        <ol className={styles.steps}>
          {steps.map((step, index) => (
            <li key={step}>
              <span className={styles.stepNumber} aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
              <div><h3>{t(`steps.${step}.title`)}</h3><p>{t(`steps.${step}.description`)}</p></div>
            </li>
          ))}
        </ol>
        <aside className={styles.handoff}>
          <h3>{t("handoffTitle")}</h3>
          <p>{t("handoffBody")}</p>
        </aside>
      </section>

      <footer className={styles.footer}>
        <p>{t("pilotStatus")}</p>
        {pilotContact && <a className={styles.primaryAction} href={pilotContact} rel="noopener">{t("pilotAction")}</a>}
      </footer>
    </main>
  );
}
