"use client";

import { useParams, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";

export default function IntakeForm({
  statementVersionId,
  statementBody,
  categoryOptions,
}: {
  statementVersionId: string;
  statementBody: string;
  categoryOptions: { value: string; label: string }[];
}) {
  const t = useTranslations("newCase");
  const router = useRouter();
  const params = useParams();
  const locale = params.locale as string;

  const [respondentEmail, setRespondentEmail] = useState("");
  const [respondentDisplayName, setRespondentDisplayName] = useState("");
  const [category, setCategory] = useState(categoryOptions[0]?.value ?? "RETAIL");
  const [disputeDescription, setDisputeDescription] = useState("");
  const [amountAtStake, setAmountAtStake] = useState("");
  const [simulated, setSimulated] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [status, setStatus] = useState<{ kind: "idle" | "busy" | "error"; message?: string }>({ kind: "idle" });

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setStatus({ kind: "busy" });

    const res = await fetch("/api/cases", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        respondentEmail,
        respondentDisplayName,
        category,
        disputeDescription,
        ...(amountAtStake.trim() === "" ? {} : { amountAtStake: Number(amountAtStake) }),
        requestedStatementVersionId: statementVersionId,
        simulated,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setStatus({ kind: "error", message: data.message || t("error") });
      return;
    }

    router.push(`/${locale}/cases/${data.caseId}`);
  }

  return (
    <form onSubmit={handleSubmit}>
      <div role="group" aria-labelledby="consent-statement-heading" className="statement">
        <h2 id="consent-statement-heading">{t("statementHeading")}</h2>
        <p>{statementBody}</p>
      </div>

      <div className="field">
        <label htmlFor="respondent-email">{t("respondentEmailLabel")}</label>
        <input id="respondent-email" type="email" required value={respondentEmail} onChange={(e) => setRespondentEmail(e.target.value)} />
      </div>

      <div className="field">
        <label htmlFor="respondent-name">{t("respondentNameLabel")}</label>
        <input id="respondent-name" type="text" value={respondentDisplayName} onChange={(e) => setRespondentDisplayName(e.target.value)} />
        <p className="hint">{t("respondentNameHint")}</p>
      </div>

      <div className="field">
        <label htmlFor="category">{t("categoryLabel")}</label>
        <select id="category" value={category} onChange={(e) => setCategory(e.target.value)}>
          {categoryOptions.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor="dispute-description">{t("disputeDescriptionLabel")}</label>
        <textarea id="dispute-description" required maxLength={2000} rows={4} value={disputeDescription} aria-describedby="dispute-description-hint" onChange={(e) => setDisputeDescription(e.target.value)} />
        <p id="dispute-description-hint" className="hint">{t("disputeDescriptionHint")}</p>
      </div>

      <div className="field">
        <label htmlFor="amount-at-stake">{t("amountLabel")}</label>
        <input id="amount-at-stake" type="number" min={0} step="0.01" inputMode="decimal" value={amountAtStake} aria-describedby="amount-at-stake-hint" onChange={(e) => setAmountAtStake(e.target.value)} />
        <p id="amount-at-stake-hint" className="hint">{t("amountHint")}</p>
      </div>

      <div className="field">
        <label htmlFor="simulated">
          <input id="simulated" type="checkbox" checked={simulated} onChange={(e) => setSimulated(e.target.checked)} /> {t("simulatedLabel")}
        </label>
      </div>

      <div className="field">
        <label htmlFor="acknowledge">
          <input id="acknowledge" type="checkbox" required checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />{" "}
          {t("acknowledgeLabel")}
        </label>
      </div>

      <button type="submit" disabled={status.kind === "busy" || !acknowledged}>
        {status.kind === "busy" ? t("submitting") : t("submitButton")}
      </button>
      {status.kind === "error" && (
        <p role="alert" className="alert">
          {status.message}
        </p>
      )}
    </form>
  );
}
