"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import styles from "./invites.module.css";

interface InvitationView { id: string; expiresAt: string; revokedAt: string | null; claimedAt: string | null; emailedAt: string | null; user: { email: string; displayName: string; globalRole: string } }

export default function InviteManager({ invitations, emailReady }: { invitations: InvitationView[]; emailReady: boolean }) {
  const t = useTranslations("adminInvites");
  const locale = useLocale();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [claimPath, setClaimPath] = useState("");
  async function issue(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    setBusy(true); setMessage(""); setClaimPath("");
    try {
      const response = await fetch("/api/auth/invite", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: fields.get("email"), displayName: fields.get("displayName"), globalRole: fields.get("globalRole"), locale: fields.get("locale"), sendEmail: fields.get("sendEmail") === "on" }) });
      const data = await response.json();
      if (!response.ok) throw new Error("Invite failed");
      setClaimPath(data.claimPath);
      setMessage(t(`delivery.${data.delivery as "manual" | "accepted" | "failed" | "not_configured"}`));
      form.reset(); router.refresh();
    } catch { setMessage(t("failed")); }
    finally { setBusy(false); }
  }
  async function revoke(invitationId: string) {
    setBusy(true); setMessage(""); setClaimPath("");
    try {
      const response = await fetch("/api/auth/invite", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ invitationId }) });
      if (!response.ok) throw new Error("Revocation failed");
      setMessage(t("revoked")); router.refresh();
    } catch { setMessage(t("failed")); }
    finally { setBusy(false); }
  }
  async function retryMail() {
    setBusy(true);
    try {
      const response = await fetch("/api/auth/invite", { method: "PATCH" });
      if (!response.ok) throw new Error("Delivery failed");
      const result = await response.json();
      setMessage(t(result.pending ? "mailPending" : "mailAccepted"));
    } catch { setMessage(t("failed")); }
    finally { setBusy(false); }
  }
  return <>
    <form className={styles.form} onSubmit={issue}>
      <label>{t("email")}<input name="email" type="email" required disabled={busy} /></label>
      <label>{t("displayName")}<input name="displayName" required disabled={busy} /></label>
      <label>{t("role")}<select name="globalRole" disabled={busy}>{["COMPLAINANT", "RESPONDENT", "CASE_MANAGER"].map(role => <option key={role} value={role}>{t(`roles.${role as "COMPLAINANT" | "RESPONDENT" | "CASE_MANAGER"}`)}</option>)}</select></label>
      <label>{t("language")}<select name="locale" defaultValue={locale} disabled={busy}><option value="fr-CA">Français</option><option value="en-CA">English</option></select></label>
      <label className={styles.check}><input type="checkbox" name="sendEmail" defaultChecked={emailReady} disabled={!emailReady || busy} />{t("sendEmail")}</label>
      {!emailReady && <p>{t("emailUnavailable")}</p>}
      <button disabled={busy}>{t("issue")}</button>
    </form>
    {message && <p role="status">{message}</p>}
    {claimPath && <label className={styles.link}>{t("claimLink")}<input readOnly value={typeof window === "undefined" ? claimPath : new URL(claimPath, window.location.origin).toString()} onFocus={event => event.target.select()} /></label>}
    <div className={styles.tableWrap}><table><caption>{t("recent")}</caption><thead><tr><th>{t("email")}</th><th>{t("role")}</th><th>{t("status")}</th><th>{t("actions")}</th></tr></thead><tbody>
      {invitations.map(item => { const status = item.revokedAt ? "revoked" : item.claimedAt ? "claimed" : new Date(item.expiresAt) <= new Date() ? "expired" : "active"; return <tr key={item.id}><td>{item.user.email}</td><td>{t(`roles.${item.user.globalRole as "COMPLAINANT" | "RESPONDENT" | "CASE_MANAGER"}`)}</td><td>{t(`states.${status}`)}{item.emailedAt && ` · ${t("emailAccepted")}`}</td><td>{status === "active" && <button type="button" disabled={busy} onClick={() => revoke(item.id)}>{t("revoke")}</button>}</td></tr>; })}
    </tbody></table></div>
    <button type="button" disabled={busy || !emailReady} onClick={retryMail}>{t("retryMail")}</button>
  </>;
}
