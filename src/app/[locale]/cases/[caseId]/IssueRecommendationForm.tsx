"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";

export default function IssueRecommendationForm({ recommendationId }: { recommendationId: string }) {
  const t = useTranslations("workspace.recommendation");
  const router = useRouter();
  const [checklist, setChecklist] = useState({ reviewedEvidence: false, confirmedLimits: false, acceptsResponsibility: false });
  const [status, setStatus] = useState<{ kind: "idle" | "busy" | "error"; message?: string }>({ kind: "idle" });

  const allChecked = checklist.reviewedEvidence && checklist.confirmedLimits && checklist.acceptsResponsibility;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setStatus({ kind: "busy" });
    const res = await fetch(`/api/recommendations/${recommendationId}/issue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ checklist }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setStatus({ kind: "error", message: data.message || t("error") });
      return;
    }
    setStatus({ kind: "idle" });
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} style={{ marginTop: "1rem", borderTop: "1px solid #ddd", paddingTop: "1rem" }}>
      <div style={{ marginBottom: "0.5rem" }}>
        <label>
          <input
            type="checkbox"
            checked={checklist.reviewedEvidence}
            onChange={(e) => setChecklist((c) => ({ ...c, reviewedEvidence: e.target.checked }))}
          />{" "}
          {t("checklist.reviewedEvidence")}
        </label>
      </div>
      <div style={{ marginBottom: "0.5rem" }}>
        <label>
          <input
            type="checkbox"
            checked={checklist.confirmedLimits}
            onChange={(e) => setChecklist((c) => ({ ...c, confirmedLimits: e.target.checked }))}
          />{" "}
          {t("checklist.confirmedLimits")}
        </label>
      </div>
      <div style={{ marginBottom: "0.75rem" }}>
        <label>
          <input
            type="checkbox"
            checked={checklist.acceptsResponsibility}
            onChange={(e) => setChecklist((c) => ({ ...c, acceptsResponsibility: e.target.checked }))}
          />{" "}
          {t("checklist.acceptsResponsibility")}
        </label>
      </div>
      <button type="submit" disabled={!allChecked || status.kind === "busy"}>
        {status.kind === "busy" ? t("issuing") : t("issueButton")}
      </button>
      {status.kind === "error" && (
        <p role="alert" className="alert">
          {status.message}
        </p>
      )}
    </form>
  );
}
