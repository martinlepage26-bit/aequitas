"use client";

import { useTranslations } from "next-intl";
import styles from "./workspace.module.css";

const stages = [
  { key: "dossier", href: "#dispute-heading", states: ["DRAFT"] },
  { key: "evidence", href: "#evidence-heading", states: ["OPEN", "EVIDENCE_INTAKE"] },
  { key: "positions", href: "#positions-heading", states: ["POSITIONS"] },
  { key: "review", href: "#authority-heading", states: ["DRAFTING", "ISSUED"] },
  { key: "resolution", href: "#timeline-heading", states: ["RESOLVED_CONSENT", "RESOLVED_DECLINED", "CLOSED"] },
] as const;

export default function CaseJourney({ state }: { state: string }) {
  const t = useTranslations("workspace.journey");
  const terminal = state === "WITHDRAWN";
  const current = Math.max(0, stages.findIndex((stage) => (stage.states as readonly string[]).includes(state)));
  return (
    <nav className={styles.journey} aria-label={t("title")}>
      <div className={styles.journeyHeading}>
        <div><p className="kicker">{t("eyebrow")}</p><h2>{t("title")}</h2></div>
        <span className={styles.journeyState} data-terminal={terminal || undefined}>
          <span className={styles.statusLight} aria-hidden="true" />
          {terminal ? t("withdrawn") : t("current", { stage: t(`stages.${stages[current].key}`) })}
        </span>
      </div>
      <ol className={styles.journeySteps}>
        {stages.map((stage, index) => {
          const active = index === current && !terminal;
          const complete = index < current || state === "CLOSED" || state.startsWith("RESOLVED_");
          return <li key={stage.key} data-active={active || undefined} data-complete={complete || undefined}>
            <a href={stage.href} aria-current={active ? "step" : undefined}>
              <span className={styles.journeyDot} aria-hidden="true">{complete ? "✓" : index + 1}</span>
              <span className={styles.journeyLabel}>{t(`stages.${stage.key}`)}</span>
            </a>
          </li>;
        })}
      </ol>
    </nav>
  );
}
