"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import styles from "./workspace.module.css";

function usePost(url: string, body: () => unknown) {
  const router = useRouter();
  const [status, setStatus] = useState<"idle" | "busy" | "error">("idle");
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setStatus("busy");
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body()),
    });
    if (!response.ok) {
      setStatus("error");
      return;
    }
    setStatus("idle");
    router.refresh();
  }
  return { status, submit };
}

export function AddAssumptionForm({ caseId, label, button }: { caseId: string; label: string; button: string }) {
  const [text, setText] = useState("");
  const form = usePost(`/api/cases/${caseId}/pipeline/assumptions`, () => ({ text, origin: "ANALYST_NOTE" }));
  return (
    <form onSubmit={form.submit} className={styles.form}>
      <div className={styles.formRow}>
        <label htmlFor="assumption-text">{label}</label>
        <textarea id="assumption-text" required maxLength={4000} value={text} onChange={(event) => setText(event.target.value)} />
      </div>
      <button type="submit" disabled={form.status === "busy"}>{button}</button>
    </form>
  );
}

export function AssumptionButtons({
  caseId,
  assumptionId,
  acknowledge,
  challenge,
}: {
  caseId: string;
  assumptionId: string;
  acknowledge: string;
  challenge: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function send(action: "acknowledge" | "challenge") {
    setBusy(true);
    const response = await fetch(`/api/cases/${caseId}/pipeline/assumptions/${assumptionId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action }),
    });
    setBusy(false);
    if (response.ok) router.refresh();
  }
  return (
    <p>
      <button type="button" disabled={busy} onClick={() => send("acknowledge")}>{acknowledge}</button>
      {" "}
      <button type="button" disabled={busy} onClick={() => send("challenge")}>{challenge}</button>
    </p>
  );
}

export function ProposalActions({
  caseId,
  proposalId,
  kind,
  accept,
  reject,
  confidenceLabel,
  rationaleLabel,
  confidence,
}: {
  caseId: string;
  proposalId: string;
  kind: string;
  accept: string;
  reject: string;
  confidenceLabel: string;
  rationaleLabel: string;
  confidence: Record<"ESTABLISHED" | "PROBABLE" | "DISPUTED" | "UNKNOWN", string>;
}) {
  const router = useRouter();
  const [level, setLevel] = useState<"ESTABLISHED" | "PROBABLE" | "DISPUTED" | "UNKNOWN">("UNKNOWN");
  const [rationale, setRationale] = useState("");
  const [busy, setBusy] = useState(false);
  async function send(action: "accept" | "reject") {
    setBusy(true);
    const response = await fetch(`/api/cases/${caseId}/pipeline/proposals/${proposalId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action,
        confidence: level,
        confidenceRationale: rationale,
        locale: document.documentElement.lang === "en-CA" ? "en-CA" : "fr-CA",
      }),
    });
    setBusy(false);
    if (response.ok) router.refresh();
  }
  return (
    <div className={styles.form}>
      {kind === "CLAIM" && (
        <>
          <div className={styles.formRow}>
            <label htmlFor={`proposal-confidence-${proposalId}`}>{confidenceLabel}</label>
            <select id={`proposal-confidence-${proposalId}`} value={level} onChange={(event) => setLevel(event.target.value as typeof level)}>
              {(Object.keys(confidence) as Array<keyof typeof confidence>).map((key) => (
                <option key={key} value={key}>{confidence[key]}</option>
              ))}
            </select>
          </div>
          <div className={styles.formRow}>
            <label htmlFor={`proposal-rationale-${proposalId}`}>{rationaleLabel}</label>
            <textarea id={`proposal-rationale-${proposalId}`} maxLength={4000} value={rationale} onChange={(event) => setRationale(event.target.value)} />
          </div>
        </>
      )}
      <button type="button" disabled={busy} onClick={() => send("accept")}>{accept}</button>
      {" "}
      <button type="button" disabled={busy} onClick={() => send("reject")}>{reject}</button>
    </div>
  );
}

export function ReturnForm({
  caseId,
  title,
  reasonLabel,
  button,
  stages,
}: {
  caseId: string;
  title: string;
  reasonLabel: string;
  button: string;
  stages: Array<{ value: string; label: string }>;
}) {
  const [toStage, setToStage] = useState(stages[0]?.value ?? "EPOCHE");
  const [reason, setReason] = useState("");
  const form = usePost(`/api/cases/${caseId}/pipeline/return`, () => ({ toStage, reason }));
  return (
    <form onSubmit={form.submit} className={styles.form}>
      <h3>{title}</h3>
      <div className={styles.formRow}>
        <label htmlFor="pipeline-return-stage">{title}</label>
        <select id="pipeline-return-stage" value={toStage} onChange={(event) => setToStage(event.target.value)}>
          {stages.map((stage) => <option key={stage.value} value={stage.value}>{stage.label}</option>)}
        </select>
      </div>
      <div className={styles.formRow}>
        <label htmlFor="pipeline-return-reason">{reasonLabel}</label>
        <textarea id="pipeline-return-reason" required maxLength={2000} value={reason} onChange={(event) => setReason(event.target.value)} />
      </div>
      <button type="submit" disabled={form.status === "busy"}>{button}</button>
    </form>
  );
}

export function AssembleButton({ caseId, label }: { caseId: string; label: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <p>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          const response = await fetch(`/api/cases/${caseId}/pipeline/synthesis`, { method: "POST" });
          setBusy(false);
          if (response.ok) router.refresh();
        }}
      >
        {label}
      </button>
    </p>
  );
}
