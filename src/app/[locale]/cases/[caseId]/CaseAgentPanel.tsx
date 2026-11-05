"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";

export type CaseAgentPanelProps = {
  caseId: string;
  viewer: "party" | "manager";
  agentManaged: boolean;
  escalated: boolean;
  escalationReason: string | null;
  closed: boolean;
  canEnroll: boolean;
};

/**
 * Tells each person, in plain language, that an automated assistant handles
 * routine steps, what it does not do, and how to reach a person. Parties
 * get a "request a person" button; the assigned manager can opt a case in.
 */
export default function CaseAgentPanel(props: CaseAgentPanelProps) {
  const t = useTranslations("workspace.caseAgent");
  const router = useRouter();
  const [status, setStatus] = useState<{ kind: "idle" | "busy" | "error"; message?: string }>({ kind: "idle" });

  async function post(path: string) {
    setStatus({ kind: "busy" });
    try {
      const res = await fetch(`/api/cases/${props.caseId}/${path}`, { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setStatus({ kind: "error", message: data.message || t("error") });
        return;
      }
      setStatus({ kind: "idle" });
      router.refresh();
    } catch {
      setStatus({ kind: "error", message: t("error") });
    }
  }

  if (!props.agentManaged && !(props.viewer === "manager" && props.canEnroll)) return null;
  const reason = props.escalationReason ? t(`reason.${props.escalationReason}`) : "";

  return (
    <section aria-labelledby="case-agent-heading" id="case-agent">
      <h2 id="case-agent-heading">{t("title")}</h2>
      {props.viewer === "party" && props.agentManaged && (
        <>
          <p id="case-agent-notice">{t("partyNotice")}</p>
          {props.escalated
            ? <p id="case-agent-escalated" role="status">{t("partyEscalated")}</p>
            : !props.closed && (
              <button type="button" id="request-human-review" onClick={() => post("human-review")} disabled={status.kind === "busy"}>
                {status.kind === "busy" ? t("requesting") : t("requestButton")}
              </button>
            )}
        </>
      )}
      {props.viewer === "manager" && props.agentManaged && (
        <p id="case-agent-status" role="status">{props.escalated ? t("managerEscalated", { reason }) : t("managerActive")}</p>
      )}
      {props.viewer === "manager" && !props.agentManaged && props.canEnroll && (
        <>
          <p>{t("enrollHelp")}</p>
          <button type="button" id="enroll-case-agent" onClick={() => post("agent")} disabled={status.kind === "busy"}>{t("enrollButton")}</button>
        </>
      )}
      {status.kind === "error" && <p role="alert" className="alert">{status.message}</p>}
    </section>
  );
}
