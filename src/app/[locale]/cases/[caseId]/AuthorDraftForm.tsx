"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";

type EvidenceOption = { id: string; title: string };
type Citation = { evidence_item_id: string; relevance: string };
export type AuthoredDraftInitial = {
  summary: string;
  proposed_outcome: string;
  reasoning: string;
  limits: string[];
  not_considered: string[];
  evidence_citations: Citation[];
};

const lines = (value: string) => value.split("\n").map(line => line.trim()).filter(Boolean);

/**
 * The assigned case manager writes the recommendation draft directly. No
 * model is called. Issuing it is still the separate checklist below.
 */
export default function AuthorDraftForm({ caseId, evidence, replacesRecommendationId, initial }: {
  caseId: string;
  evidence: EvidenceOption[];
  replacesRecommendationId: string | null;
  initial?: AuthoredDraftInitial;
}) {
  const t = useTranslations("workspace.authorDraft");
  const router = useRouter();
  const [summary, setSummary] = useState(initial?.summary ?? "");
  const [proposedOutcome, setProposedOutcome] = useState(initial?.proposed_outcome ?? "");
  const [reasoning, setReasoning] = useState(initial?.reasoning ?? "");
  const [limits, setLimits] = useState((initial?.limits ?? []).join("\n"));
  const [notConsidered, setNotConsidered] = useState((initial?.not_considered ?? []).join("\n"));
  const [citations, setCitations] = useState<Record<string, string>>(
    Object.fromEntries((initial?.evidence_citations ?? []).map(c => [c.evidence_item_id, c.relevance])),
  );
  const [reason, setReason] = useState("");
  const [status, setStatus] = useState<{ kind: "idle" | "busy" | "error"; message?: string }>({ kind: "idle" });
  const replacing = replacesRecommendationId !== null;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setStatus({ kind: "busy" });
    try {
      const res = await fetch(`/api/cases/${caseId}/authored-draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          replacesRecommendationId,
          reason: replacing ? reason : undefined,
          explanation: {
            summary,
            proposed_outcome: proposedOutcome,
            reasoning,
            limits: lines(limits),
            not_considered: lines(notConsidered),
            evidence_citations: Object.entries(citations).map(([evidence_item_id, relevance]) => ({ evidence_item_id, relevance })),
          },
        }),
      });
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

  return (
    <details style={{ marginTop: "1rem", borderTop: "1px solid #ddd", paddingTop: "1rem" }} open={!replacing}>
      <summary>{replacing ? t("replaceTitle") : t("title")}</summary>
      <p>{t("intro")}</p>
      <form onSubmit={handleSubmit} aria-describedby={`author-draft-help-${caseId}`}>
        <p id={`author-draft-help-${caseId}`}>{t("help")}</p>
        <label htmlFor="author-draft-summary">{t("summaryLabel")}</label>
        <textarea id="author-draft-summary" required rows={3} value={summary} onChange={e => setSummary(e.target.value)} />
        <label htmlFor="author-draft-outcome">{t("proposedOutcomeLabel")}</label>
        <textarea id="author-draft-outcome" required rows={4} value={proposedOutcome} onChange={e => setProposedOutcome(e.target.value)} />
        <label htmlFor="author-draft-reasoning">{t("reasoningLabel")}</label>
        <textarea id="author-draft-reasoning" required rows={6} value={reasoning} onChange={e => setReasoning(e.target.value)} />
        <label htmlFor="author-draft-limits">{t("limitsLabel")}</label>
        <textarea id="author-draft-limits" required rows={3} value={limits} onChange={e => setLimits(e.target.value)} aria-describedby="author-draft-lines-hint" />
        <label htmlFor="author-draft-not-considered">{t("notConsideredLabel")}</label>
        <textarea id="author-draft-not-considered" required rows={3} value={notConsidered} onChange={e => setNotConsidered(e.target.value)} aria-describedby="author-draft-lines-hint" />
        <p id="author-draft-lines-hint">{t("onePerLine")}</p>
        {evidence.length > 0 && (
          <fieldset>
            <legend>{t("citationsLegend")}</legend>
            {evidence.map(item => {
              const checked = item.id in citations;
              return (
                <div key={item.id} style={{ marginBottom: "0.5rem" }}>
                  <label>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={e => setCitations(current => {
                        const next = { ...current };
                        if (e.target.checked) next[item.id] = "";
                        else delete next[item.id];
                        return next;
                      })}
                    />{" "}
                    {item.title}
                  </label>
                  {checked && (
                    <>
                      <label htmlFor={`author-draft-relevance-${item.id}`}>{t("relevanceLabel", { title: item.title })}</label>
                      <input
                        id={`author-draft-relevance-${item.id}`}
                        required
                        value={citations[item.id]}
                        onChange={e => setCitations(current => ({ ...current, [item.id]: e.target.value }))}
                      />
                    </>
                  )}
                </div>
              );
            })}
          </fieldset>
        )}
        {replacing && (
          <>
            <label htmlFor="author-draft-reason">{t("reasonLabel")}</label>
            <textarea id="author-draft-reason" required rows={2} value={reason} onChange={e => setReason(e.target.value)} />
          </>
        )}
        <button type="submit" disabled={status.kind === "busy"}>
          {status.kind === "busy" ? t("saving") : t("save")}
        </button>
        {status.kind === "error" && <p role="alert" className="alert">{status.message}</p>}
      </form>
    </details>
  );
}
