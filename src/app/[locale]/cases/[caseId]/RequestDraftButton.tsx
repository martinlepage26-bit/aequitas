"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";

export default function RequestDraftButton({ caseId }: { caseId: string }) {
  const t = useTranslations("workspace.draftRequest");
  const router = useRouter();
  const [status, setStatus] = useState<{ kind: "idle" | "busy" | "error"; message?: string }>({ kind: "idle" });

  async function handleClick() {
    setStatus({ kind: "busy" });
    try {
    const res = await fetch(`/api/cases/${caseId}/draft-requests`, { method: "POST" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setStatus({ kind: "error", message: data.message || t("error") });
      router.refresh();
      return;
    }
    setStatus({ kind: "idle" });
    router.refresh();
    } catch { setStatus({ kind: "error", message: t("error") }); }
  }

  return (
    <div style={{ marginTop: "1rem", borderTop: "1px solid var(--border)", paddingTop: "1rem" }}>
      <button type="button" onClick={handleClick} disabled={status.kind === "busy"}>
        {status.kind === "busy" ? t("requesting") : t("requestButton")}
      </button>
      {status.kind === "error" && (
        <p role="alert" className="alert">
          {status.message}
        </p>
      )}
    </div>
  );
}
