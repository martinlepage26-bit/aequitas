"use client";

import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import styles from "./workspace.module.css";

export default function PositionForm({ caseId, disabled = false }: { caseId: string; disabled?: boolean }) {
  const t = useTranslations("workspace.positions");
  const locale = useLocale();
  const router = useRouter();
  const [body, setBody] = useState("");
  const [status, setStatus] = useState<{ kind: "idle" | "busy" | "error" | "success"; message?: string }>({ kind: "idle" });

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (disabled || status.kind === "busy") return;
    setStatus({ kind: "busy" });

    try {
      const res = await fetch(`/api/cases/${caseId}/positions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body, locale }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setStatus({ kind: "error", message: data.message || t("form.error") });
        return;
      }

      setBody("");
      setStatus({ kind: "success" });
      router.refresh();
    } catch {
      setStatus({ kind: "error", message: t("form.error") });
    }
  }

  return (
    <form onSubmit={handleSubmit} className={styles.form} aria-label={t("form.submit")} aria-describedby="position-guidance">
      <fieldset disabled={disabled || status.kind === "busy"}>
      <div className={styles.formRow}>
        <label htmlFor="position-body">{t("form.bodyLabel")}</label>
        <textarea
          id="position-body"
          required
          rows={8}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          style={{ width: "100%" }}
        />
      </div>
      <button type="submit" disabled={status.kind === "busy"}>
        {status.kind === "busy" ? t("form.submitting") : t("form.submit")}
      </button>
      </fieldset>
      {status.kind === "error" && (
        <p role="alert" className={styles.error}>
          {status.message}
        </p>
      )}
      <p role="status" className={styles.hint}>{status.kind === "success" ? t("form.success") : ""}</p>
    </form>
  );
}
