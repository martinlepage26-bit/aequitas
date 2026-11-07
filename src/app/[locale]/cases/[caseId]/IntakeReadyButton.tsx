"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";

export default function IntakeReadyButton({ caseId, ready }: { caseId: string; ready: boolean }) {
  const t = useTranslations("workspace.caseAgent");
  const router = useRouter();
  const [status, setStatus] = useState<{ kind: "idle" | "busy" | "error"; message?: string }>({ kind: "idle" });

  async function updateReadiness() {
    if (status.kind === "busy") return;
    setStatus({ kind: "busy" });
    try {
      const response = await fetch(`/api/cases/${caseId}/intake-ready`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ready: !ready }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        const codeMessage = data.code === "INTAKE_EVIDENCE_PENDING_OR_REJECTED"
          ? t("intakeReadyResolveEvidence")
          : data.code === "INTAKE_CLEAN_EVIDENCE_REQUIRED"
            ? t("intakeReadyEvidenceRequired")
            : undefined;
        setStatus({ kind: "error", message: codeMessage || t("intakeReadyError") });
        router.refresh();
        return;
      }
      setStatus({ kind: "idle" });
      router.refresh();
    } catch {
      setStatus({ kind: "error", message: t("intakeReadyError") });
    }
  }

  return (
    <section aria-labelledby="intake-ready-heading">
      <h3 id="intake-ready-heading">{t("intakeReadyTitle")}</h3>
      <p>{t("intakeReadyHelp")}</p>
      {ready && <p role="status">{t("intakeReadyMarked")}</p>}
      <button type="button" onClick={updateReadiness} disabled={status.kind === "busy"}>
        {status.kind === "busy" ? t("intakeReadySaving") : ready ? t("intakeReadyClear") : t("intakeReadyMark")}
      </button>
      {status.kind === "error" && <p role="alert">{status.message}</p>}
    </section>
  );
}
