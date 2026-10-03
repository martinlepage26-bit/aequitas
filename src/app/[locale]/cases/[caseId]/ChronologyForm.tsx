"use client";

import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import styles from "./workspace.module.css";

export default function ChronologyForm({ caseId, disabled = false }: { caseId: string; disabled?: boolean }) {
  const t = useTranslations("workspace.chronology");
  const locale = useLocale();
  const router = useRouter();
  const [occurredOn, setOccurredOn] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<"idle" | "busy" | "error" | "success">("idle");

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (disabled || status === "busy") return;
    setStatus("busy");
    try {
      const response = await fetch(`/api/cases/${caseId}/chronology`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ occurredOn, title, description, locale }),
      });
      if (!response.ok) { setStatus("error"); return; }
      setOccurredOn(""); setTitle(""); setDescription("");
      setStatus("success");
      router.refresh();
    } catch { setStatus("error"); }
  }

  return <form className={styles.form} onSubmit={handleSubmit} aria-label={t("form.submit")} aria-describedby="chronology-guidance">
    <fieldset disabled={disabled || status === "busy"}>
      <div className={styles.formRow}>
        <label htmlFor="chronology-date">{t("form.dateLabel")}</label>
        <input id="chronology-date" type="date" required value={occurredOn} onChange={e => setOccurredOn(e.target.value)} />
      </div>
      <div className={styles.formRow}>
        <label htmlFor="chronology-title">{t("form.titleLabel")}</label>
        <input id="chronology-title" type="text" required maxLength={200} value={title} onChange={e => setTitle(e.target.value)} />
      </div>
      <div className={styles.formRow}>
        <label htmlFor="chronology-description">{t("form.descriptionLabel")}</label>
        <textarea id="chronology-description" required rows={4} maxLength={8000} value={description} onChange={e => setDescription(e.target.value)} aria-describedby="chronology-description-hint" />
        <p id="chronology-description-hint" className={styles.hint}>{t("form.hint")}</p>
      </div>
      <button type="submit">{status === "busy" ? t("form.submitting") : t("form.submit")}</button>
    </fieldset>
    {status === "error" && <p role="alert" className={styles.error}>{t("form.error")}</p>}
    <p role="status" className={styles.hint}>{status === "success" ? t("form.success") : ""}</p>
  </form>;
}
