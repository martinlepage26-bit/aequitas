"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";

export default function PositionForm({ caseId }: { caseId: string }) {
  const t = useTranslations("workspace.positions");
  const router = useRouter();
  const [body, setBody] = useState("");
  const [status, setStatus] = useState<{ kind: "idle" | "busy" | "error"; message?: string }>({ kind: "idle" });

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setStatus({ kind: "busy" });

    const res = await fetch(`/api/cases/${caseId}/positions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setStatus({ kind: "error", message: data.message || t("form.error") });
      return;
    }

    setBody("");
    setStatus({ kind: "idle" });
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} style={{ marginTop: "1rem", borderTop: "1px solid #ddd", paddingTop: "1rem" }}>
      <div style={{ marginBottom: "0.75rem" }}>
        <label htmlFor="position-body">{t("form.bodyLabel")}</label>
        <br />
        <textarea
          id="position-body"
          required
          rows={4}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          style={{ width: "100%" }}
        />
      </div>
      <button type="submit" disabled={status.kind === "busy"}>
        {status.kind === "busy" ? t("form.submitting") : t("form.submit")}
      </button>
      {status.kind === "error" && (
        <p role="alert" style={{ color: "#8A2A2A" }}>
          {status.message}
        </p>
      )}
    </form>
  );
}
