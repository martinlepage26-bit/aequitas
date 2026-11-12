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

      <footer className={styles.footer}>
        <p>{t("pilotStatus")}</p>
        {pilotContact && <a className={styles.primaryAction} href={pilotContact} rel="noopener">{t("pilotAction")}</a>}
      </footer>
    </main>
  );
}
