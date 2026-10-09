"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";

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
    <div className="panel stack">
      <label className="field" htmlFor="case-state-filter" style={{ maxWidth: "16rem", marginBottom: 0 }}>
        <span>{t("filterLabel")}</span>
        <select id="case-state-filter" value={state} onChange={(event) => setState(event.target.value)}>
          <option value="ALL">{t("filterAll")}</option>
          {options.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      {visible.length === 0 ? <p>{t("filterEmpty")}</p> : (
        <div className="table-wrap">
          <table className="data-table">
            <caption className="visually-hidden">{t("title")}</caption>
            <thead>
              <tr>
                <th scope="col">{t("columns.reference")}</th>
                <th scope="col">{t("columns.state")}</th>
                <th scope="col">{t("columns.party")}</th>
                <th scope="col">{t("viewLink")}</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <tr key={row.id}>
                  <td className="ref">{row.referenceNumber}</td>
                  <td>{row.stateLabel}</td>
                  <td>{row.detail}</td>
                  <td><a href={row.href}>{t("viewLink")}</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
