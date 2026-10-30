"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import styles from "./case-list.module.css";

export interface CaseRow {
  id: string;
  referenceNumber: string;
  state: string;
  stateLabel: string;
  detail: string;
  href: string;
}

export default function CaseTable({ rows }: { rows: CaseRow[] }) {
  const t = useTranslations("caseList");
  const [state, setState] = useState("ALL");
  const options = useMemo(() => {
    const seen = new Map<string, string>();
    for (const row of rows) seen.set(row.state, row.stateLabel);
    return [...seen.entries()];
  }, [rows]);
  const visible = state === "ALL" ? rows : rows.filter((row) => row.state === state);

  return (
    <div className={styles.list}>
      <div className={styles.filters} role="group" aria-label={t("filterLabel")}>
        <button type="button" aria-pressed={state === "ALL"} onClick={() => setState("ALL")}>{t("filterAll")}</button>
        {options.map(([value, label]) => <button key={value} type="button" aria-pressed={state === value} onClick={() => setState(value)}>{label}<span>{rows.filter(row => row.state === value).length}</span></button>)}
      </div>
      <p className={styles.count} aria-live="polite">{t("showing", { count: visible.length })}</p>
      {visible.length === 0 ? <p>{t("filterEmpty")}</p> : (
        <ul className={styles.cards}>{visible.map((row) => <li key={row.id}>
          <a className={styles.card} href={row.href}>
            <span className={styles.caseIcon} aria-hidden="true"><span /></span>
            <span className={styles.cardBody}><strong className="ref">{row.referenceNumber}</strong><span>{row.detail}</span></span>
            <span className={styles.state}><i aria-hidden="true" />{row.stateLabel}</span>
            <span className={styles.action}>{t(row.state === "DRAFT" ? "resumeLink" : "viewLink")} <span aria-hidden="true">→</span></span>
          </a>
        </li>)}</ul>
      )}
    </div>
  );
}
