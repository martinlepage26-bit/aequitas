"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import type { DisputeCategory } from "../../../../generated/prisma";
import styles from "./workspace.module.css";

export default function CaseDetailsEditor({
  caseId,
  revision,
  category,
  categoryOptions,
  disputeDescription,
  amountAtStakeCents,
  respondentEmail,
  respondentDisplayName,
  simulated,
}: {
  caseId: string;
  revision: string | null;
  category: DisputeCategory;
  categoryOptions: Array<{ value: DisputeCategory; label: string }>;
  disputeDescription: string;
  amountAtStakeCents: number | null;
  respondentEmail: string;
  respondentDisplayName: string;
  simulated: boolean;
}) {
  const t = useTranslations("workspace.edit");
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ category, disputeDescription, amountAtStake: amountAtStakeCents === null ? "" : (amountAtStakeCents / 100).toFixed(2), respondentEmail, respondentDisplayName, simulated });
  const [status, setStatus] = useState<{ kind: "idle" | "busy" | "error" | "success"; message?: string }>({ kind: "idle" });

  function reset() {
    setDraft({ category, disputeDescription, amountAtStake: amountAtStakeCents === null ? "" : (amountAtStakeCents / 100).toFixed(2), respondentEmail, respondentDisplayName, simulated });
    setStatus({ kind: "idle" });
    setEditing(false);
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (status.kind === "busy") return;
    setStatus({ kind: "busy" });
    try {
      const response = await fetch(`/api/cases/${caseId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...draft,
          expectedRevision: revision,
          amountAtStake: draft.amountAtStake.trim() === "" ? null : Number(draft.amountAtStake),
        }),
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        setStatus({ kind: "error", message: result.message || t("error") });
        return;
      }
      setStatus({ kind: "success" });
      setEditing(false);
      router.refresh();
    } catch { setStatus({ kind: "error", message: t("error") }); }
  }

  return (
    <div className={styles.editor}>
      {!editing ? (
        <button type="button" className={styles.secondaryButton} onClick={() => { setStatus({ kind: "idle" }); setEditing(true); }}>{t("editButton")}</button>
      ) : (
        <form onSubmit={save}>
          <h3>{t("title")}</h3>
          <p className={styles.hint}>{t("hint")}</p>
          <div className={styles.formRow}>
            <label htmlFor="edit-respondent-name">{t("respondentName")}</label>
            <input id="edit-respondent-name" type="text" required maxLength={200} value={draft.respondentDisplayName} onChange={event => setDraft({ ...draft, respondentDisplayName: event.target.value })} />
          </div>
          <div className={styles.formRow}>
            <label htmlFor="edit-respondent-email">{t("respondentEmail")}</label>
            <input id="edit-respondent-email" type="email" required maxLength={254} value={draft.respondentEmail} onChange={event => setDraft({ ...draft, respondentEmail: event.target.value })} />
          </div>
          <div className={styles.formRow}>
            <label htmlFor="edit-category">{t("category")}</label>
            <select id="edit-category" value={draft.category} onChange={event => setDraft({ ...draft, category: event.target.value as DisputeCategory })}>
              {categoryOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </div>
          <div className={styles.formRow}>
            <label htmlFor="edit-description">{t("description")}</label>
            <textarea id="edit-description" required maxLength={2000} rows={5} value={draft.disputeDescription} onChange={event => setDraft({ ...draft, disputeDescription: event.target.value })} />
          </div>
          <div className={styles.formRow}>
            <label htmlFor="edit-amount">{t("amount")}</label>
            <input id="edit-amount" type="number" min="0" step="0.01" inputMode="decimal" value={draft.amountAtStake} onChange={event => setDraft({ ...draft, amountAtStake: event.target.value })} />
          </div>
          <div className={styles.formRow}>
            <label htmlFor="edit-simulated"><input id="edit-simulated" type="checkbox" checked={draft.simulated} onChange={event => setDraft({ ...draft, simulated: event.target.checked })} /> {t("simulated")}</label>
          </div>
          <div className={styles.editActions}>
            <button type="submit" disabled={status.kind === "busy"}>{status.kind === "busy" ? t("saving") : t("save")}</button>
            <button type="button" className={styles.secondaryButton} onClick={reset} disabled={status.kind === "busy"}>{t("cancel")}</button>
          </div>
        </form>
      )}
      {status.kind === "error" && <p role="alert" className={styles.error}>{status.message}</p>}
      {status.kind === "success" && <p role="status">{t("saved")}</p>}
    </div>
  );
}
