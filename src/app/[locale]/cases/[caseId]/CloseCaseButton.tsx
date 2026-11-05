"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";

export default function CloseCaseButton({ caseId }: { caseId: string }) {
  const t = useTranslations("workspace.close");
  const router = useRouter();
  const [status, setStatus] = useState<{ kind: "idle" | "busy" | "error"; message?: string }>({ kind: "idle" });

  async function handleClose() {
    setStatus({ kind: "busy" });
    const res = await fetch(`/api/cases/${caseId}/close`, { method: "POST" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setStatus({ kind: "error", message: data.message || t("error") });
      return;
    }
    setStatus({ kind: "idle" });
    router.refresh();
  }

  return (
    <div style={{ marginTop: "1rem", borderTop: "1px solid var(--border)", paddingTop: "1rem" }}>
      <button type="button" onClick={handleClose} disabled={status.kind === "busy"}>
        {status.kind === "busy" ? t("closing") : t("closeButton")}
      </button>
      {status.kind === "error" && (
        <p role="alert" className="alert">
          {status.message}
        </p>
      )}
    </div>
  );
}
