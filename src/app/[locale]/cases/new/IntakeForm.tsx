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
      <div
        role="group"
        aria-labelledby="consent-statement-heading"
        style={{ border: "1px solid #ccc", padding: "1rem", marginBottom: "1rem", maxHeight: "12rem", overflowY: "auto" }}
      >
        <h2 id="consent-statement-heading" style={{ fontSize: "1rem", marginTop: 0 }}>
          {t("statementHeading")}
        </h2>
        <p>{statementBody}</p>
      </div>

      <div style={{ marginBottom: "1rem" }}>
        <label htmlFor="respondent-email">{t("respondentEmailLabel")}</label>
        <br />
        <input
          id="respondent-email"
          type="email"
          required
          value={respondentEmail}
          onChange={(e) => setRespondentEmail(e.target.value)}
          style={{ width: "100%" }}
        />
      </div>

      <div style={{ marginBottom: "1rem" }}>
        <label htmlFor="respondent-name">{t("respondentNameLabel")}</label>
        <br />
        <input
          id="respondent-name"
          type="text"
          value={respondentDisplayName}
          onChange={(e) => setRespondentDisplayName(e.target.value)}
          style={{ width: "100%" }}
        />
        <p style={{ fontSize: "0.85rem", color: "#555" }}>{t("respondentNameHint")}</p>
      </div>

      <div style={{ marginBottom: "1rem" }}>
        <label htmlFor="category">{t("categoryLabel")}</label>
        <br />
        <select id="category" value={category} onChange={(e) => setCategory(e.target.value)} style={{ width: "100%" }}>
          {categoryOptions.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      <div style={{ marginBottom: "1rem" }}>
        <label htmlFor="dispute-description">{t("disputeDescriptionLabel")}</label>
        <br />
        <textarea
          id="dispute-description"
          required
          maxLength={2000}
          rows={4}
          value={disputeDescription}
          aria-describedby="dispute-description-hint"
          onChange={(e) => setDisputeDescription(e.target.value)}
          style={{ width: "100%" }}
        />
        <p id="dispute-description-hint" style={{ fontSize: "0.85rem", color: "#555" }}>
          {t("disputeDescriptionHint")}
        </p>
      </div>

      <div style={{ marginBottom: "1rem" }}>
        <label htmlFor="amount-at-stake">{t("amountLabel")}</label>
        <br />
        <input
          id="amount-at-stake"
          type="number"
          min={0}
          step="0.01"
          inputMode="decimal"
          value={amountAtStake}
          aria-describedby="amount-at-stake-hint"
          onChange={(e) => setAmountAtStake(e.target.value)}
          style={{ width: "100%" }}
        />
        <p id="amount-at-stake-hint" style={{ fontSize: "0.85rem", color: "#555" }}>
          {t("amountHint")}
        </p>
      </div>

      <div style={{ marginBottom: "1rem" }}>
        <label htmlFor="simulated">
          <input id="simulated" type="checkbox" checked={simulated} onChange={(e) => setSimulated(e.target.checked)} /> {t("simulatedLabel")}
        </label>
      </div>

      <div style={{ marginBottom: "1rem" }}>
        <label htmlFor="acknowledge">
          <input id="acknowledge" type="checkbox" required checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />{" "}
          {t("acknowledgeLabel")}
        </label>
      </div>

      <button type="submit" disabled={status.kind === "busy" || !acknowledged}>
        {status.kind === "busy" ? t("submitting") : t("submitButton")}
      </button>
      {status.kind === "error" && (
        <p role="alert" style={{ color: "#8A2A2A" }}>
          {status.message}
        </p>
      )}
    </form>
  );
}
