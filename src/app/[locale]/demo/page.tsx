import Image from "next/image";
import Link from "next/link";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { renderProposal } from "../../../domain/caseAgent/proposal";
import { pilotContactUrl } from "../../../lib/pilotContact";
import CaseDemoInteraction from "./CaseDemoInteraction";
import styles from "./demo.module.css";

const AMOUNT_AT_STAKE_CENTS = 12_450;

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "caseDemo" });
  return { title: `${t("title")} · Aequitas`, description: t("metadata") };
}

/** A public simulation. Its fictional proposal text comes from the app's fixed template. */
export default async function CaseDemoPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("caseDemo");
  const pilotContact = pilotContactUrl();
  const amount = new Intl.NumberFormat(locale, { style: "currency", currency: "CAD" }).format(AMOUNT_AT_STAKE_CENTS / 100);
  const complainantProposal = renderProposal({ remedy: "replacement", amount_cents: null }, AMOUNT_AT_STAKE_CENTS, "complainant", locale);
  const respondentProposal = renderProposal({ remedy: "replacement", amount_cents: null }, AMOUNT_AT_STAKE_CENTS, "respondent", locale);
  const parties = {
    complainant: {
      label: t("party.complainant"),
      position: t("sample.claim"),
      evidence: t("sample.complainantEvidence"),
      proposal: complainantProposal,
    },
    respondent: {
      label: t("party.respondent"),
      position: t("sample.response"),
      evidence: t("sample.respondentEvidence"),
      proposal: respondentProposal,
    },
  };
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
              loading="eager"
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

      <section className={styles.caseSection} aria-labelledby="about-title">
        <p className={styles.kicker}>{t("overview.kicker")}</p>
        <h2 id="about-title">{t("overview.title")}</h2>
        <p className={styles.trustIntro}>{t("overview.body")}</p>
        <div className={styles.trustGrid}>
          {(["kind", "helps"] as const).map(item => <article className={styles.trustCard} key={item}>
            <h3>{t(`overview.${item}.title`)}</h3><p>{t(`overview.${item}.body`)}</p>
          </article>)}
        </div>
      </section>

      <section className={styles.caseSection} aria-labelledby="sample-case-title">
        <div className={styles.caseHeading}>
          <div>
            <h2 id="sample-case-title">{t("caseTitle")}</h2>
            <p>{t("caseDescription")}</p>
          </div>
          <p className={styles.amount}><span>{t("amountLabel")}</span><strong>{amount}</strong></p>
        </div>
      </section>

      <CaseDemoInteraction
        parties={parties}
        copy={{
          title: t("interaction.title"),
          description: t("interaction.description"),
          roleLabel: t("interaction.roleLabel"),
          roleNotice: t("interaction.roleNotice"),
          positionLabel: t("interaction.positionLabel"),
          evidenceTitle: t("evidenceTitle"),
          evidenceLabel: t("evidenceLabel"),
          proposalTitle: t("proposalTitle"),
          proposalDescription: t("proposalDescription"),
          choiceTitle: t("interaction.choiceTitle"),
          choiceHint: t("interaction.choiceHint"),
          consent: t("interaction.consent"),
          decline: t("interaction.decline"),
          askPerson: t("interaction.askPerson"),
          reset: t("interaction.reset"),
          statusLabel: t("interaction.statusLabel"),
          status: {
            initial: t("interaction.status.initial"),
            accepted: t("interaction.status.accepted"),
            completed: t("interaction.status.completed"),
            handoff: t("interaction.status.handoff"),
          },
        }}
      />

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

      <section className={styles.trustSection} aria-labelledby="trust-title">
        <p className={styles.kicker}>{t("trust.kicker")}</p>
        <h2 id="trust-title">{t("trust.title")}</h2>
        <p className={styles.trustIntro}>{t("trust.intro")}</p>
        <div className={styles.trustGrid}>
          {(["trace", "separation", "choice", "handoff"] as const).map(item => (
            <article className={styles.trustCard} key={item}>
              <span aria-hidden="true" className={styles.trustMark}>—</span>
              <h3>{t(`trust.${item}.title`)}</h3>
              <p>{t(`trust.${item}.body`)}</p>
            </article>
          ))}
        </div>
        <aside className={styles.limits} aria-labelledby="limits-title">
          <div>
            <p className={styles.kicker}>{t("trust.readinessLabel")}</p>
            <h3 id="limits-title">{t("trust.readinessTitle")}</h3>
          </div>
          <p>{t("trust.readinessBody")}</p>
        </aside>
      </section>

      <section className={styles.nextSection} aria-labelledby="inside-title">
        <p className={styles.kicker}>{t("inside.kicker")}</p>
        <h2 id="inside-title">{t("inside.title")}</h2>
        <p className={styles.trustIntro}>{t("inside.intro")}</p>
        <div className={styles.trustGrid}>
          {(["rules", "extract", "draft", "record"] as const).map(item => <article className={styles.trustCard} key={item}>
            <h3>{t(`inside.${item}.title`)}</h3><p>{t(`inside.${item}.body`)}</p>
          </article>)}
        </div>
        <aside className={styles.limits} aria-labelledby="limits-title">
          <div><p className={styles.kicker}>{t("limits.kicker")}</p><h3 id="limits-title">{t("limits.title")}</h3></div>
          <p>{t("limits.body")}</p>
        </aside>
      </section>

      <footer className={styles.footer}>
        <p>{t("pilotStatus")}</p>
        {pilotContact && <a className={styles.primaryAction} href={pilotContact} rel="noopener">{t("pilotAction")}</a>}
      </footer>
    </main>
  );
}
