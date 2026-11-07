"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import styles from "./workspace.module.css";

export default function RespondentInviteButton({ caseId, email, name, alreadySent, deliveryUncertain }: { caseId: string; email: string; name: string; alreadySent: boolean; deliveryUncertain: boolean }) {
  const t = useTranslations("workspace.inviteRespondent");
  const [confirming, setConfirming] = useState(false);
  const [status, setStatus] = useState<"idle" | "busy" | "sent" | "uncertain" | "error">(deliveryUncertain ? "uncertain" : alreadySent ? "sent" : "idle");

  async function send() {
    if (status === "busy") return;
    setStatus("busy");
    try {
      const response = await fetch(`/api/cases/${caseId}/invite-respondent`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmedEmail: email }),
      });
      const result = await response.json().catch(() => null);
      // A queued (delivery_pending) or unconfirmed email has not been shown to
      // be delivered; do not report it as sent.
      if (result?.status === "delivery_uncertain" || result?.status === "delivery_pending") {
        setStatus("uncertain");
        setConfirming(false);
        return;
      }
      if (!response.ok) { setStatus("error"); return; }
      setStatus("sent");
      setConfirming(false);
    } catch { setStatus("error"); }
  }

  return <section className={styles.section} aria-labelledby="invite-respondent-heading">
    <h2 id="invite-respondent-heading">{t("title")}</h2>
    <p>{t("description", { name, email })}</p>
    {status === "sent" ? <p role="status">{t("sent")}</p> : status === "uncertain" ? <p role="status">{t("uncertain")}</p> : !confirming ? (
      <button type="button" onClick={() => { setStatus("idle"); setConfirming(true); }}>{t("openConfirm")}</button>
    ) : (
      <div className={styles.confirmBox} role="group" aria-label={t("confirmTitle")}>
        <p><strong>{t("confirmTitle")}</strong></p>
        <p>{t("confirmBody", { email })}</p>
        <div className={styles.editActions}>
          <button type="button" onClick={send} disabled={status === "busy"}>{status === "busy" ? t("sending") : t("send")}</button>
          <button type="button" className={styles.secondaryButton} onClick={() => { setConfirming(false); setStatus("idle"); }} disabled={status === "busy"}>{t("cancel")}</button>
        </div>
      </div>
    )}
    {status === "error" && <p role="alert" className={styles.error}>{t("error")}</p>}
  </section>;
}
