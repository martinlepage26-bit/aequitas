"use client";

import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { Mark, Wordmark } from "./icons";
import { usePasskeyFlow } from "./usePasskeyFlow";
import styles from "../app/auth/sign-in/sign-in.module.css";

export default function AuthForm({ returnTo }: { returnTo: string }) {
  const router = useRouter();
  const locale = useLocale();
  const t = useTranslations("auth");
  const [mode, setMode] = useState<"sign-in" | "register">("sign-in");
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [globalRole, setGlobalRole] = useState("COMPLAINANT");
  const [error, setError] = useState("");
  const flow = usePasskeyFlow();
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    try {
      await flow.run(async (signal) => {
        const endpoint = `/api/auth/webauthn/${mode === "sign-in" ? "authenticate" : "register"}`;
        async function post(data: unknown) {
          const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data), signal });
          if (!response.ok) throw new Error("Authentication failed");
          return response.json();
        }
        const optionsJSON = await post({ step: "options", email, displayName, globalRole, locale });
        signal.throwIfAborted();
        const response = mode === "sign-in" ? await startAuthentication({ optionsJSON }) : await startRegistration({ optionsJSON });
        signal.throwIfAborted();
        await post({ step: "verify", response });
        signal.throwIfAborted();
        router.replace(returnTo);
        router.refresh();
      });
    } catch (cause) {
      setError(t(cause instanceof DOMException && ["AbortError", "TimeoutError", "NotAllowedError"].includes(cause.name) ? "cancelled" : "failed"));
    }
  }
  return (
    <main className={styles.page}>
      <div className={styles.frame}>
        <div className={styles.mark}>
          <Link href={`/${locale}`} className={styles.wordmark}><Mark /><Wordmark>Aequitas</Wordmark></Link>
          <span className={styles.tagline}>{t("tagline")}</span>
          <Link href={`/${locale === "fr-CA" ? "en-CA" : "fr-CA"}/auth/sign-in?next=${encodeURIComponent(returnTo.replace(`/${locale}/`, `/${locale === "fr-CA" ? "en-CA" : "fr-CA"}/`))}`}>{t("otherLanguage")}</Link>
        </div>
        <div className={styles.card}>
          <div className={styles.tabs} role="group" aria-label={t("chooseMode")}>
            {(["sign-in", "register"] as const).map((value) => <button key={value} type="button" disabled={flow.busy} className={`${styles.tab} ${mode === value ? styles.tabActive : ""}`} aria-pressed={mode === value} onClick={() => { setMode(value); setError(""); }}>{t(value === "sign-in" ? "signIn" : "register")}</button>)}
          </div>
          <form onSubmit={submit}>
            {mode === "register" && <div className={styles.beamField}>
              <span className={styles.beamLabel} id="role-label">{t("role")}</span>
              <div className={styles.beam} data-role={globalRole}>
                <div className={styles.beamTrack}><div className={styles.beamBar} aria-hidden="true" /><div className={styles.fulcrum} aria-hidden="true" /></div>
                <div className={styles.beamNodes} role="radiogroup" aria-labelledby="role-label">
                  {(["COMPLAINANT", "RESPONDENT"] as const).map((role) => <button key={role} type="button" role="radio" disabled={flow.busy} aria-checked={globalRole === role} onClick={() => setGlobalRole(role)} className={`${styles.beamNode} ${role === "COMPLAINANT" ? styles.beamNodeLeft : styles.beamNodeRight}`}>{t(role === "COMPLAINANT" ? "complainant" : "respondent")}</button>)}
                </div>
              </div>
            </div>}
            <div className={styles.field}><label htmlFor="email" className={styles.label}>{t("email")}</label><input id="email" className={styles.input} type="email" autoComplete="email" required disabled={flow.busy} value={email} onChange={(event) => setEmail(event.target.value)} /></div>
            {mode === "register" && <div className={styles.field}><label htmlFor="displayName" className={styles.label}>{t("displayName")}</label><input id="displayName" className={styles.input} required disabled={flow.busy} value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></div>}
            <button className={styles.submit} disabled={flow.busy}>{flow.busy ? t("waiting") : t(mode === "sign-in" ? "continue" : "create")}</button>
            {flow.busy && <button type="button" className={styles.cancel} onClick={flow.cancel}>{t("cancel")}</button>}
          </form>
          <p className={styles.passkeyNote}>{t("passkeyNote")}</p>
          {error && <p role="alert" className={`${styles.status} ${styles.statusError}`}>{error}</p>}
        </div>
      </div>
    </main>
  );
}
