"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";

export default function OpenIntakeButton({ caseId }: { caseId: string }) {
  const t = useTranslations("workspace.open");
  const router = useRouter();
  const [hasConflict, setHasConflict] = useState(false);
  const [coiDetails, setCoiDetails] = useState("");
  const [status, setStatus] = useState<{ kind: "idle" | "busy" | "error"; message?: string }>({ kind: "idle" });

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setStatus({ kind: "busy" });
    const res = await fetch(`/api/cases/${caseId}/open-intake`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hasConflict, coiDetails: coiDetails || undefined }),
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
        <label htmlFor="coi-has-conflict">
          <input
            id="coi-has-conflict"
            type="checkbox"
            checked={hasConflict}
            onChange={(e) => setHasConflict(e.target.checked)}
          />{" "}
          {t("coiLabel")}
        </label>
      </div>
      {hasConflict && (
        <div style={{ marginBottom: "0.75rem" }}>
          <label htmlFor="coi-details">{t("coiDetailsLabel")}</label>
          <br />
          <input id="coi-details" type="text" value={coiDetails} onChange={(e) => setCoiDetails(e.target.value)} style={{ width: "100%" }} />
        </div>
      )}
      <button type="submit" disabled={status.kind === "busy"}>
        {status.kind === "busy" ? t("opening") : t("openButton")}
      </button>
      {status.kind === "error" && (
        <p role="alert" className="alert">
          {status.message}
        </p>
      )}
    </form>
  );
}
