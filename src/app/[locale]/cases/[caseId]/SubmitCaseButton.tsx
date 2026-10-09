"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";

export default function SubmitCaseButton({ caseId }: { caseId: string }) {
  const t = useTranslations("workspace.draft");
  const router = useRouter();
  const [status, setStatus] = useState<{ kind: "idle" | "busy" | "error"; message?: string }>({ kind: "idle" });

  async function handleSubmit() {
    setStatus({ kind: "busy" });
    const res = await fetch(`/api/cases/${caseId}/submit`, { method: "POST" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setStatus({ kind: "error", message: data.message || t("error") });
      return;
    }
    setStatus({ kind: "idle" });
    router.refresh();
  }

  return (
    <div style={{ marginTop: "1rem", borderTop: "1px solid #ddd", paddingTop: "1rem" }}>
      <button type="button" onClick={handleSubmit} disabled={status.kind === "busy"}>
        {status.kind === "busy" ? t("submitting") : t("submitButton")}
      </button>
      {status.kind === "error" && (
        <p role="alert" className="alert">
          {status.message}
        </p>
      )}
    </div>
  );
}
