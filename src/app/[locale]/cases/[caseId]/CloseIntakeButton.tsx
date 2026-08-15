"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";

export default function CloseIntakeButton({ caseId }: { caseId: string }) {
  const t = useTranslations("workspace.intake");
  const router = useRouter();
  const [overrideReason, setOverrideReason] = useState("");
  const [status, setStatus] = useState<{ kind: "idle" | "busy" | "error"; message?: string }>({ kind: "idle" });

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setStatus({ kind: "busy" });

    const res = await fetch(`/api/cases/${caseId}/close-intake`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ overrideReason: overrideReason || undefined }),
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
      <div style={{ marginBottom: "0.75rem" }}>
        <label htmlFor="intake-override">{t("overrideLabel")}</label>
        <br />
        <input
          id="intake-override"
          type="text"
          value={overrideReason}
          onChange={(e) => setOverrideReason(e.target.value)}
          style={{ width: "100%" }}
        />
      </div>
      <button type="submit" disabled={status.kind === "busy"}>
        {status.kind === "busy" ? t("closing") : t("closeButton")}
      </button>
      {status.kind === "error" && (
        <p role="alert" style={{ color: "#8A2A2A" }}>
          {status.message}
        </p>
      )}
    </form>
  );
}
