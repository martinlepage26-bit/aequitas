"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import type { ResolutionView } from "../../../../domain/resolution";
import styles from "./workspace.module.css";

export interface ContestTargetOption {
  type: "CLAIM" | "SYNTHESIS" | "PROPOSAL" | "RECOMMENDATION";
  id: string;
  label: string;
}

const KNOWN_CODES = new Set([
  "OPEN_CONTESTATION",
  "APPROVAL_REQUIRED",
  "ADMIN_CANNOT_APPROVE",
  "NOT_APPROVER",
  "PARTY_CANNOT_APPROVE",
  "SAME_AUTHOR",
  "MISSING_RATIONALE",
  "NO_ISSUED_RECOMMENDATION",
  "ALREADY_APPROVED",
  "CONTESTATION_NOT_OPEN",
  "TARGET_NOT_ON_CASE",
  "CASE_NOT_CONTESTABLE",
]);

/**
 * Phase 3: contestations on this case, what blocks resolution, and the
 * approver sign-off. Parties and the assigned case manager open a
 * contestation; the assigned case manager responds; an approver who does not
 * own the case overrules with a reason or signs off with a rationale.
 */
export default function ResolutionPanel({
  caseId,
  view,
  viewerId,
  complainantId,
  respondentId,
  targets,
  sectionClassName,
}: {
  caseId: string;
  view: ResolutionView;
  viewerId: string;
  complainantId: string;
  respondentId: string;
  targets: ContestTargetOption[];
  sectionClassName?: string;
}) {
  const t = useTranslations("workspace.resolution");
  const tRole = useTranslations("workspace.role");
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [target, setTarget] = useState(targets[0] ? `${targets[0].type}:${targets[0].id}` : "");
  const [grounds, setGrounds] = useState("");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [rationale, setRationale] = useState("");

  function message(data: { code?: string; message?: string }) {
    if (data.code && KNOWN_CODES.has(data.code)) return t(`code.${data.code}` as Parameters<typeof t>[0]);
    return data.message || t("error");
  }

  async function post(url: string, body: unknown, done: string) {
    setBusy(true);
    setError(null);
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    setBusy(false);
    if (!res.ok) {
      const text = message(await res.json().catch(() => ({})));
      setError(text);
      setAnnouncement(text);
      return false;
    }
    setAnnouncement(done);
    router.refresh();
    return true;
  }

  async function open(event: React.FormEvent) {
    event.preventDefault();
    const [targetType, targetId] = target.split(":");
    if (await post(`/api/cases/${caseId}/contestations`, { targetType, targetId, grounds }, t("openedAnnouncement"))) setGrounds("");
  }

  const targetLabel = (type: string, id: string) => targets.find((o) => o.type === type && o.id === id)?.label ?? t(`target.${type}` as Parameters<typeof t>[0]);

  return (
    <section aria-labelledby="resolution-heading" className={sectionClassName}>
      <h2 id="resolution-heading">{t("title")}</h2>
      <div aria-live="polite" role="status" className="visually-hidden">
        {announcement}
      </div>
      <p>{view.consentOnlyResolution ? t("consentOnly") : t("approvalPath")}</p>

      <h3>{t("blockersHeading")}</h3>
      {view.blockers.length === 0 ? (
        <p id="resolution-unblocked">{t("noBlockers")}</p>
      ) : (
        <ul id="resolution-blockers">
          {view.blockers.map((code) => (
            <li key={code} data-code={code}>{t(`code.${code}`)}</li>
          ))}
        </ul>
      )}

      <h3>{t("approvalHeading")}</h3>
      {view.approval ? (
        <p id="resolution-approval">{t("approvedBy", { name: view.approval.approverName, rationale: view.approval.rationale ?? "" })}</p>
      ) : (
        <p>{t("notApproved")}</p>
      )}
      {view.viewer.canApprove && (
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            if (await post(`/api/cases/${caseId}/approval`, { rationale }, t("approvedAnnouncement"))) setRationale("");
          }}
        >
          <label htmlFor="approval-rationale">{t("rationaleLabel")}</label>
          <textarea id="approval-rationale" value={rationale} onChange={(e) => setRationale(e.target.value)} required maxLength={4000} />
          <button type="submit" id="approve-resolution" disabled={busy}>{t("approveButton")}</button>
        </form>
      )}
      {!view.viewer.canApprove && view.viewer.approveBlockedCode && <p className="hint">{t(`code.${view.viewer.approveBlockedCode}`)}</p>}

      <h3>{t("contestationsHeading")}</h3>
      {view.contestations.length === 0 ? (
        <p>{t("noContestations")}</p>
      ) : (
        <ul id="contestation-list">
          {view.contestations.map((c) => (
            <li key={c.id} data-status={c.status} className={styles.originRecord} data-origin={c.openedById === complainantId ? "COMPLAINANT" : c.openedById === respondentId ? "RESPONDENT" : "CASE_MANAGER"}>
              <span className={styles.originLabel}>{c.openedById === complainantId ? tRole("complainant") : c.openedById === respondentId ? tRole("respondent") : tRole("caseManager")}</span>
              <p>
                <strong>{t(`status.${c.status}`)}</strong> — {targetLabel(c.targetType, c.targetId)} — {t("openedBy", { name: c.openedByName })}
              </p>
              <p>{c.grounds}</p>
              {c.response && <p className={styles.originRecord} data-origin="CASE_MANAGER"><span className={styles.originLabel}>{tRole("caseManager")}</span> {t("responseBy", { name: c.respondedByName ?? "", text: c.response })}</p>}
              {c.overruleReason && <p className={styles.originRecord} data-origin="CASE_MANAGER"><span className={styles.originLabel}>{tRole("caseManager")}</span> {t("overruledBy", { name: c.overruledByName ?? "", text: c.overruleReason })}</p>}
              {c.status === "OPEN" && (view.viewer.canRespond || view.viewer.canOverrule) && (
                <>
                  <label htmlFor={`contestation-note-${c.id}`}>{view.viewer.canRespond ? t("responseLabel") : t("overruleLabel")}</label>
                  <textarea
                    id={`contestation-note-${c.id}`}
                    value={notes[c.id] ?? ""}
                    onChange={(e) => setNotes({ ...notes, [c.id]: e.target.value })}
                    maxLength={4000}
                  />
                </>
              )}
              {c.status === "OPEN" && (
                <div className="button-row">
                  {view.viewer.canRespond && (
                    <button type="button" disabled={busy} onClick={() => post(`/api/cases/${caseId}/contestations/${c.id}`, { action: "respond", text: notes[c.id] ?? "" }, t("respondedAnnouncement"))}>
                      {t("respondButton")}
                    </button>
                  )}
                  {view.viewer.canOverrule && (
                    <button type="button" disabled={busy} onClick={() => post(`/api/cases/${caseId}/contestations/${c.id}`, { action: "overrule", text: notes[c.id] ?? "" }, t("overruledAnnouncement"))}>
                      {t("overruleButton")}
                    </button>
                  )}
                  {c.openedById === viewerId && (
                    <button type="button" disabled={busy} onClick={() => post(`/api/cases/${caseId}/contestations/${c.id}`, { action: "withdraw" }, t("withdrawnAnnouncement"))}>
                      {t("withdrawButton")}
                    </button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {view.viewer.canOpen && targets.length > 0 && (
        <form onSubmit={open} id="open-contestation-form">
          <h3>{t("openHeading")}</h3>
          <label htmlFor="contestation-target">{t("targetLabel")}</label>
          <select id="contestation-target" value={target} onChange={(e) => setTarget(e.target.value)}>
            {targets.map((o) => (
              <option key={`${o.type}:${o.id}`} value={`${o.type}:${o.id}`}>{o.label}</option>
            ))}
          </select>
          <label htmlFor="contestation-grounds">{t("groundsLabel")}</label>
          <textarea id="contestation-grounds" value={grounds} onChange={(e) => setGrounds(e.target.value)} required maxLength={4000} />
          <button type="submit" id="open-contestation" disabled={busy}>{t("openButton")}</button>
        </form>
      )}

      {error && (
        <p role="alert" className="alert">
          {error}
        </p>
      )}
    </section>
  );
}
