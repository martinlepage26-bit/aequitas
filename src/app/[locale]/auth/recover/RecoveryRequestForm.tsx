"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import styles from "../../../auth/sign-in/sign-in.module.css";

export default function RecoveryRequestForm() {
  const t = useTranslations("recovery");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(false);
    try {
      const response = await fetch("/api/auth/recovery/request", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) });
      if (!response.ok) { setError(true); return; }
      setDone(true);
    } catch { setError(true); }
    finally { setBusy(false); }
  }

  return done ? <p role="status" className={styles.recoverySuccess}>{t("requested")}</p> : <form onSubmit={submit}>
    <div className={styles.field}><label htmlFor="recovery-email" className={styles.label}>{t("email")}</label><input id="recovery-email" type="email" autoComplete="email" required maxLength={254} value={email} onChange={event => setEmail(event.target.value)} disabled={busy} /></div>
    <button className={styles.submit} type="submit" disabled={busy}>{busy ? t("sending") : t("sendLink")}</button>
    {error && <p role="alert" className={styles.statusError}>{t("requestError")}</p>}
  </form>;
}
