"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import styles from "./workspace.module.css";

export interface CaseActivityItem {
  id: string;
  type: string;
  createdAt: string;
  actorRole: "COMPLAINANT" | "RESPONDENT" | "CASE_MANAGER" | "ADMIN" | null;
  actorName: string | null;
}

export default function CaseActivity({ events, locale }: { events: CaseActivityItem[]; locale: string }) {
  const t = useTranslations("workspace");
  const [role, setRole] = useState("ALL");
  const visible = useMemo(() => role === "ALL" ? events : events.filter((event) => event.actorRole === role), [events, role]);
  const labels: Record<string, string> = {
    ALL: t("timeline.filters.all"),
    COMPLAINANT: t("role.complainant"),
    RESPONDENT: t("role.respondent"),
    CASE_MANAGER: t("role.caseManager"),
  };
  const format = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  return <section aria-labelledby="timeline-heading" className={styles.section}>
    <div className={styles.activityHeading}>
      <div><h2 id="timeline-heading">{t("timeline.title")}</h2><p>{t("timeline.description")}</p></div>
      <span className={styles.eventCount}><span className={styles.statusLight} aria-hidden="true" />{t("timeline.count", { count: visible.length })}</span>
    </div>
    <div className={styles.timelineFilters} role="group" aria-label={t("timeline.filters.label")}>
      {Object.entries(labels).map(([key, label]) => <button key={key} type="button" aria-pressed={role === key} onClick={() => setRole(key)}>{label}</button>)}
    </div>
    {visible.length === 0 ? <p>{t("timeline.empty")}</p> : <ol className={styles.activityList}>
      {visible.map((event) => <li key={event.id} data-origin={event.actorRole ?? undefined}>
        <span className={styles.activityDot} aria-hidden="true" />
        <div className={styles.activityCard}>
          <div className={styles.activityMeta}>
            <time dateTime={event.createdAt}>{format.format(new Date(event.createdAt))}</time>
            {event.actorRole && <span className={styles.originLabel} data-origin={event.actorRole}>{labels[event.actorRole] ?? t("role.admin")}</span>}
          </div>
          <p><strong>{t(`timeline.event.${event.type}`)}</strong>{event.actorName && <> {t("timeline.by", { name: event.actorName })}</>}</p>
        </div>
      </li>)}
    </ol>}
  </section>;
}
