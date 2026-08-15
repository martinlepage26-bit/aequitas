"use client";

import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { useState } from "react";

type Mode = "sign-in" | "register";
type Status = { kind: "idle" | "busy" | "error" | "success"; message?: string };

// Global-role registration/sign-in is not scoped to any one case, so it has
// no dispute category to resolve a domain-specific term from (that only
// happens inside a case workspace — see src/i18n/categoryGlossary.ts). These
// labels stay the neutral, internal role names.
const ROLES = [
  { value: "COMPLAINANT", label: "Complainant" },
  { value: "RESPONDENT", label: "Respondent" },
  { value: "CASE_MANAGER", label: "Neutral case manager" },
];

export default function SignInPage() {
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

  async function handleRegister(event: React.FormEvent) {
    event.preventDefault();
    setStatus({ kind: "busy" });
    try {
      const optionsJSON = await postJson("/api/auth/webauthn/register", { step: "options", email, displayName, globalRole });
      const response = await startRegistration({ optionsJSON });
      const user = await postJson("/api/auth/webauthn/register", { step: "verify", response });
      setStatus({ kind: "success", message: `Registered as ${user.displayName} (${user.globalRole}).` });
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
      setStatus({ kind: "success", message: `Signed in as ${user.displayName} (${user.globalRole}).` });
    } catch (error) {
      setStatus({ kind: "error", message: (error as Error).message });
    }
  }

  return (
    <main style={{ maxWidth: "28rem", margin: "4rem auto", padding: "0 1rem", fontFamily: "system-ui, sans-serif" }}>
      <h1>Aequitas — {mode === "sign-in" ? "Sign in" : "Register"}</h1>
      <div role="group" aria-label="Choose sign-in or register" style={{ marginBottom: "1.5rem" }}>
        <button type="button" onClick={() => setMode("sign-in")} aria-pressed={mode === "sign-in"} style={{ marginRight: "0.5rem" }}>
          Sign in
        </button>
        <button type="button" onClick={() => setMode("register")} aria-pressed={mode === "register"}>
          Register
        </button>
      </div>

      <form onSubmit={mode === "sign-in" ? handleSignIn : handleRegister}>
        <div style={{ marginBottom: "1rem" }}>
          <label htmlFor="email">Email</label>
          <br />
          <input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} style={{ width: "100%" }} />
        </div>

        {mode === "register" && (
          <>
            <div style={{ marginBottom: "1rem" }}>
              <label htmlFor="displayName">Display name</label>
              <br />
              <input
                id="displayName"
                type="text"
                required
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                style={{ width: "100%" }}
              />
            </div>
            <div style={{ marginBottom: "1rem" }}>
              <label htmlFor="globalRole">Role</label>
              <br />
              <select id="globalRole" value={globalRole} onChange={(e) => setGlobalRole(e.target.value)} style={{ width: "100%" }}>
                {ROLES.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </div>
          </>
        )}

        <button type="submit" disabled={status.kind === "busy"}>
          {mode === "sign-in" ? "Sign in with a passkey" : "Register a passkey"}
        </button>
      </form>

      <p role="status" aria-live="polite" style={{ marginTop: "1rem", color: status.kind === "error" ? "#8A2A2A" : undefined }}>
        {status.message}
      </p>
    </main>
  );
}
