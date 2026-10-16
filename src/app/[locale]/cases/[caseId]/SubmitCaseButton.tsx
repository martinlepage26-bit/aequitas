"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import styles from "./workspace.module.css";

export default function SubmitCaseButton({ caseId }: { caseId: string }) {
  const t = useTranslations("workspace.draft");
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [status, setStatus] = useState<{ kind: "idle" | "busy" | "error"; message?: string }>({ kind: "idle" });

  async function handleSubmit() {
    setStatus({ kind: "busy" });
    const res = await fetch(`/api/cases/${caseId}/submit`, { method: "POST" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setStatus({ kind: "error", message: data.message || t("error") });
      return;
    }
    setStatus({ kind: "idle" });
    router.refresh();
  }

  return (
    <div className={styles.editor}>
      {!confirming ? <button type="button" onClick={() => setConfirming(true)}>{t("submitButton")}</button> : (
        <div className={styles.confirmBox} role="group" aria-label={t("confirmTitle")}>
          <p><strong>{t("confirmTitle")}</strong></p>
          <p>{t("confirmBody")}</p>
          <div className={styles.editActions}>
            <button type="button" onClick={handleSubmit} disabled={status.kind === "busy"}>{status.kind === "busy" ? t("submitting") : t("confirmSend")}</button>
            <button type="button" className={styles.secondaryButton} onClick={() => setConfirming(false)} disabled={status.kind === "busy"}>{t("cancel")}</button>
          </div>
        </div>
      )}
      {status.kind === "error" && (
        <p role="alert" className="alert">
          {status.message}
        </p>
      )}
    </div>
  );
}
