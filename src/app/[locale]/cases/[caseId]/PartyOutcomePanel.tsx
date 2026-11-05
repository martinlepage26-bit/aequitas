"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import PartyVisibleNotice from "./PartyVisibleNotice";

export interface PartyOutcomeParty {
  partyId: string;
  displayName: string;
  issued: { version: number; body: string; locale: string } | null;
  draft: { version: number; body: string; locale: string } | null;
}

export default function PartyOutcomePanel({
  caseId,
  parties,
  canWrite,
  locale,
}: {
  caseId: string;
  parties: PartyOutcomeParty[];
  canWrite: boolean;
  locale: string;
}) {
  const t = useTranslations("workspace.partyOutcome");
  return (
    <section aria-labelledby="party-outcomes-heading" className="panel">
      <h2 id="party-outcomes-heading">{t("title")}</h2>
      <p>{t("description")}</p>
      {!canWrite && <p>{t("readOnly")}</p>}
      {parties.map((party) => (
        <PartyOutcomeFields key={party.partyId} caseId={caseId} party={party} canWrite={canWrite} locale={locale} />
      ))}
    </section>
  );
}

function PartyOutcomeFields({
  caseId,
  party,
  canWrite,
  locale,
}: {
  caseId: string;
  party: PartyOutcomeParty;
  canWrite: boolean;
  locale: string;
}) {
  const t = useTranslations("workspace.partyOutcome");
  const router = useRouter();
  const [body, setBody] = useState(party.draft?.body ?? party.issued?.body ?? "");
  const [status, setStatus] = useState<{ kind: "idle" | "busy" | "error" | "saved" | "issued"; message?: string }>({ kind: "idle" });

  async function send(action: "save" | "issue") {
    setStatus({ kind: "busy" });
    const res = await fetch(`/api/cases/${caseId}/party-outcomes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, partyId: party.partyId, body, locale }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      const message = data.message || t("error");
      setStatus({ kind: "error", message });
      return;
    }
    setStatus({ kind: action === "save" ? "saved" : "issued" });
    router.refresh();
  }

  return (
    <div>
      <h3 id={`party-outcome-heading-${party.partyId}`}>{t("bodyLabel", { name: party.displayName })}</h3>
      {party.issued && (
        <p>
          {t("issuedStatus")} · {t("version", { version: party.issued.version })}
        </p>
      )}
      {party.draft && (
        <p>
          {t("draftStatus")} · {t("version", { version: party.draft.version })}
        </p>
      )}
      {party.draft && party.issued && (
        <p id={`party-outcome-revision-${party.partyId}`} role="note">{t("revisionPending", { version: party.issued.version })}</p>
      )}
      {canWrite ? (
        <>
          <PartyVisibleNotice partyName={party.displayName} />
          <label htmlFor={`party-outcome-body-${party.partyId}`}>{t("bodyLabel", { name: party.displayName })}</label>
          <textarea
            id={`party-outcome-body-${party.partyId}`}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            rows={6}
          />
          <div className="button-row">
            <button type="button" id={`party-outcome-save-${party.partyId}`} onClick={() => send("save")} disabled={status.kind === "busy" || body.trim().length === 0}>
              {status.kind === "busy" ? t("saving") : t("saveDraft")}
            </button>
            <button type="button" id={`party-outcome-issue-${party.partyId}`} onClick={() => send("issue")} disabled={status.kind === "busy" || body.trim().length === 0}>
              {status.kind === "busy" ? t("issuing") : t("issueButton")}
            </button>
          </div>
        </>
      ) : (
        <>
          {party.issued && <p id={`party-outcome-issued-${party.partyId}`}>{party.issued.body}</p>}
          {party.draft && <p id={`party-outcome-draft-${party.partyId}`}>{party.draft.body}</p>}
        </>
      )}
      {status.kind === "error" && (
        <p role="alert" className="alert">
          {status.message}
        </p>
      )}
      {status.kind === "saved" && <p role="status">{t("saved")}</p>}
      {status.kind === "issued" && <p role="status">{t("issuedAnnouncement")}</p>}
    </div>
  );
}
