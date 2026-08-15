"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";

/**
 * Section 7: "Explicit UI action... two buttons of equal visual weight...
 * No pre-selection. Revocation must be as easy to find as granting."
 * Consent state changes are announced via aria-live (Section 7, Section
 * 13's 4.1.3 Status Messages) — the aria-live region below is always
 * present in the DOM (not conditionally mounted) so screen readers pick up
 * the text change itself, not just a newly-appearing element.
 */
export default function ConsentPanel({
  caseId,
  statementVersionId,
  statementBody,
  ownConsentState,
}: {
  caseId: string;
  statementVersionId: string;
  statementBody: string;
  ownConsentState: "NOT_GIVEN" | "GIVEN" | "DECLINED" | "REVOKED";
}) {
  const t = useTranslations("workspace.consent");
  const router = useRouter();
  const [status, setStatus] = useState<{ kind: "idle" | "busy" | "error"; message?: string }>({ kind: "idle" });
  const [announcement, setAnnouncement] = useState("");

  async function act(action: "give" | "decline" | "revoke") {
    setStatus({ kind: "busy" });
    const res = await fetch(`/api/cases/${caseId}/consent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, statementVersionId }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setStatus({ kind: "error", message: data.message || t("error") });
      setAnnouncement(data.message || t("error"));
      return;
    }
    setStatus({ kind: "idle" });
    setAnnouncement(action === "give" ? t("givenAnnouncement") : action === "decline" ? t("declinedAnnouncement") : t("revokedAnnouncement"));
    router.refresh();
  }

  return (
    <section aria-labelledby="consent-heading" style={{ border: "1px solid #ccc", padding: "1rem", marginBottom: "1.5rem" }}>
      <h2 id="consent-heading" style={{ fontSize: "1rem", marginTop: 0 }}>
        {t("title")}
      </h2>
      <div aria-live="polite" role="status" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden" }}>
        {announcement}
      </div>

      {ownConsentState === "GIVEN" ? (
        <>
          <p>{t("givenStatus")}</p>
          <button type="button" id="revoke-consent" onClick={() => act("revoke")} disabled={status.kind === "busy"}>
            {status.kind === "busy" ? t("revoking") : t("revokeButton")}
          </button>
        </>
      ) : (
        <>
          <div role="group" aria-labelledby="consent-statement-heading" style={{ maxHeight: "10rem", overflowY: "auto", marginBottom: "1rem" }}>
            <h3 id="consent-statement-heading" style={{ fontSize: "0.95rem" }}>
              {t("statementHeading")}
            </h3>
            <p>{statementBody}</p>
          </div>
          <div style={{ display: "flex", gap: "0.75rem" }}>
            <button type="button" id="give-consent" onClick={() => act("give")} disabled={status.kind === "busy"}>
              {t("giveButton")}
            </button>
            <button type="button" id="decline-consent" onClick={() => act("decline")} disabled={status.kind === "busy"}>
              {t("declineButton")}
            </button>
          </div>
        </>
      )}
      {status.kind === "error" && (
        <p role="alert" style={{ color: "#8A2A2A" }}>
          {status.message}
        </p>
      )}
    </section>
  );
}
