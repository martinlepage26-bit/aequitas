"use client";

import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Fraunces, IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import styles from "./sign-in.module.css";

const display = Fraunces({ subsets: ["latin"], weight: ["500", "600"], variable: "--font-display" });
const body = IBM_Plex_Sans({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-body" });
const mono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["500"], variable: "--font-mono" });

type Mode = "sign-in" | "register";
type Status = { kind: "idle" | "busy" | "error" | "success"; message?: string };

// Global-role registration/sign-in is not scoped to any one case, so it has
// no dispute category to resolve a domain-specific term from (that only
// happens inside a case workspace — see src/i18n/categoryGlossary.ts). These
// labels stay the neutral, internal role names.
const ROLES = [
  { value: "COMPLAINANT", label: "Complainant" },
  { value: "CASE_MANAGER", label: "Case manager" },
  { value: "RESPONDENT", label: "Respondent" },
];

// Only COMPLAINANT has somewhere to land post-auth today (/cases/new — see
// src/app/[locale]/cases/new/page.tsx, which 404s for any other role). There
// is no case list/dashboard route yet for CASE_MANAGER or RESPONDENT; they
// arrive at a specific case via a shared /cases/[caseId] link instead. Once
// that view is added, extend this to route those roles too.
function landingPathFor(globalRole: string): string | null {
  return globalRole === "COMPLAINANT" ? "/cases/new" : null;
}

export default function SignInPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("sign-in");
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [globalRole, setGlobalRole] = useState("COMPLAINANT");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  async function postJson(url: string, body: unknown) {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || "Request failed.");
    return data;
  }

  function afterAuth(user: { displayName: string; globalRole: string }, verb: "Registered" | "Signed in") {
    const landingPath = landingPathFor(user.globalRole);
    if (landingPath) {
      router.push(landingPath);
      return;
    }
    setStatus({
      kind: "success",
      message: `${verb} as ${user.displayName} (${user.globalRole}). There's no general workspace yet for this role — use the link to your specific case.`,
    });
  }

  async function handleRegister(event: React.FormEvent) {
    event.preventDefault();
    setStatus({ kind: "busy" });
    try {
      const optionsJSON = await postJson("/api/auth/webauthn/register", { step: "options", email, displayName, globalRole });
      const response = await startRegistration({ optionsJSON });
      const user = await postJson("/api/auth/webauthn/register", { step: "verify", response });
      afterAuth(user, "Registered");
    } catch (error) {
      setStatus({ kind: "error", message: (error as Error).message });
    }
  }

  async function handleSignIn(event: React.FormEvent) {
    event.preventDefault();
    setStatus({ kind: "busy" });
    try {
      const optionsJSON = await postJson("/api/auth/webauthn/authenticate", { step: "options", email });
      const response = await startAuthentication({ optionsJSON });
      const user = await postJson("/api/auth/webauthn/authenticate", { step: "verify", response });
      afterAuth(user, "Signed in");
    } catch (error) {
      setStatus({ kind: "error", message: (error as Error).message });
    }
  }

  const statusClass = status.kind === "error" ? styles.statusError : status.kind === "success" ? styles.statusSuccess : "";

  return (
    <main className={`${styles.page} ${display.variable} ${body.variable} ${mono.variable}`} style={{ fontFamily: "var(--font-body)" }}>
      <div className={styles.frame}>
        <div className={styles.mark}>
          <span className={styles.wordmark}>Aequitas</span>
          <span className={styles.tagline}>a record both sides can read</span>
        </div>

        <div className={styles.card}>
          <div className={styles.tabs} role="group" aria-label="Choose sign-in or register">
            <button type="button" className={`${styles.tab} ${mode === "sign-in" ? styles.tabActive : ""}`} onClick={() => setMode("sign-in")} aria-pressed={mode === "sign-in"}>
              Sign in
            </button>
            <button type="button" className={`${styles.tab} ${mode === "register" ? styles.tabActive : ""}`} onClick={() => setMode("register")} aria-pressed={mode === "register"}>
              Register
            </button>
          </div>

          {mode === "register" && (
            <div className={styles.beamField}>
              <span className={styles.beamLabel} id="role-label">
                Your role in this dispute
              </span>
              <div className={styles.beam} data-role={globalRole}>
                <div className={styles.beamTrack}>
                  <div className={styles.beamBar} aria-hidden="true" />
                  <div className={styles.fulcrum} aria-hidden="true" />
                </div>
                <div className={styles.beamNodes} role="radiogroup" aria-labelledby="role-label">
                  {ROLES.map((r) => (
                    <button
                      key={r.value}
                      type="button"
                      role="radio"
                      aria-checked={globalRole === r.value}
                      onClick={() => setGlobalRole(r.value)}
                      className={`${styles.beamNode} ${
                        r.value === "COMPLAINANT" ? styles.beamNodeLeft : r.value === "RESPONDENT" ? styles.beamNodeRight : styles.beamNodeCenter
                      }`}
                    >
                      {r.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          <form onSubmit={mode === "sign-in" ? handleSignIn : handleRegister}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="email">
                Email
              </label>
              <input id="email" className={styles.input} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>

            {mode === "register" && (
              <div className={styles.field}>
                <label className={styles.label} htmlFor="displayName">
                  Display name
                </label>
                <input id="displayName" className={styles.input} type="text" required value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
              </div>
            )}

            <button type="submit" className={styles.submit} disabled={status.kind === "busy"}>
              {mode === "sign-in" ? "Continue with a passkey" : "Create a passkey"}
            </button>
          </form>

          <p className={styles.passkeyNote}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="8" cy="8" r="5" />
              <path d="M11.5 11.5 21 21M17 17l2-2M14 14l2-2" />
            </svg>
            No password to remember. Your device confirms it&apos;s you.
          </p>

          {status.message && (
            <p role="status" aria-live="polite" className={`${styles.status} ${statusClass}`}>
              {status.message}
            </p>
          )}
        </div>
      </div>
    </main>
  );
}
