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
  outcomeIssued,
  outcomeId,
  outcomeVersion,
  outcomeNeedsAnswer = false,
}: {
  caseId: string;
  statementVersionId: string;
  statementBody: string;
  ownConsentState: "NOT_GIVEN" | "GIVEN" | "DECLINED" | "REVOKED";
  outcomeIssued: boolean;
  outcomeId: string | null;
  outcomeVersion: number | null;
  outcomeNeedsAnswer?: boolean;
}) {
  const t = useTranslations("workspace.consent");
  const tResolution = useTranslations("workspace.resolution");
  const router = useRouter();
  const [status, setStatus] = useState<{ kind: "idle" | "busy" | "error"; message?: string }>({ kind: "idle" });
  const [announcement, setAnnouncement] = useState("");

  async function act(action: "give" | "decline" | "revoke") {
    setStatus({ kind: "busy" });
    const res = await fetch(`/api/cases/${caseId}/consent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action,
        statementVersionId,
        ...(action === "revoke" ? {} : { outcomeId, outcomeVersion }),
      }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      // Phase 3 resolution guards come back as 409 with a code; show the localized text.
      const text = data.code === "OUTCOME_NOT_ISSUED"
        ? t("outcomeUnavailable")
        : data.code === "OUTCOME_SUPERSEDED"
          ? t("outcomeSuperseded")
          : data.code === "OPEN_CONTESTATION" || data.code === "APPROVAL_REQUIRED" || data.code === "RESOLUTION_PAUSED"
            ? tResolution(`code.${data.code}`)
            : data.message || t("error");
      setStatus({ kind: "error", message: text });
      setAnnouncement(text);
      return;
    }
    setStatus({ kind: "idle" });
    setAnnouncement(action === "give" ? t("givenAnnouncement") : action === "decline" ? t("declinedAnnouncement") : t("revokedAnnouncement"));
    router.refresh();
  }

  return (
    <section aria-labelledby="consent-heading" className="panel">
      <h2 id="consent-heading">{t("title")}</h2>
      <div aria-live="polite" role="status" className="visually-hidden">
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
          <div role="group" aria-labelledby="consent-statement-heading" className="statement">
            <h3 id="consent-statement-heading">{t("statementHeading")}</h3>
            <p>{statementBody}</p>
          </div>
          {!outcomeIssued && <p id="outcome-unavailable" role="note">{t("outcomeUnavailable")}</p>}
          {outcomeIssued && outcomeNeedsAnswer && <p id="outcome-needs-answer" role="note">{t("outcomeNeedsAnswer")}</p>}
          <div className="button-row">
            <button type="button" id="give-consent" data-outcome-id={outcomeId ?? ""} data-outcome-version={outcomeVersion ?? ""} onClick={() => act("give")} disabled={!outcomeIssued || status.kind === "busy"}>
              {t("giveButton")}
            </button>
            <button type="button" id="decline-consent" data-outcome-id={outcomeId ?? ""} data-outcome-version={outcomeVersion ?? ""} onClick={() => act("decline")} disabled={!outcomeIssued || status.kind === "busy"}>
              {t("declineButton")}
            </button>
          </div>
        </>
      )}
      {status.kind === "error" && (
        <p role="alert" className="alert">
          {status.message}
        </p>
      )}
    </section>
  );
}
