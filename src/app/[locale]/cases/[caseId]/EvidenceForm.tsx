"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { EVIDENCE_KINDS } from "../../../../domain/evidenceKinds";

export default function EvidenceForm({ caseId }: { caseId: string }) {
  const t = useTranslations("workspace.evidence");
  const router = useRouter();
  const [kind, setKind] = useState(EVIDENCE_KINDS[0]);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<{ kind: "idle" | "busy" | "error"; message?: string }>({ kind: "idle" });

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!file) return;
    setStatus({ kind: "busy" });

    const form = new FormData();
    form.set("kind", kind);
    form.set("title", title);
    if (description) form.set("description", description);
    form.set("file", file);

    const res = await fetch(`/api/cases/${caseId}/evidence`, { method: "POST", body: form });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setStatus({ kind: "error", message: data.message || t("form.error") });
      return;
    }

    setTitle("");
    setDescription("");
    setFile(null);
    setStatus({ kind: "idle" });
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} style={{ marginTop: "1rem", borderTop: "1px solid #ddd", paddingTop: "1rem" }}>
      <div style={{ marginBottom: "0.75rem" }}>
        <label htmlFor="evidence-kind">{t("form.kindLabel")}</label>
        <br />
        <select id="evidence-kind" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
          {EVIDENCE_KINDS.map((k) => (
            <option key={k} value={k}>
              {t(`kind.${k}`)}
            </option>
          ))}
        </select>
      </div>
      <div style={{ marginBottom: "0.75rem" }}>
        <label htmlFor="evidence-title">{t("form.titleLabel")}</label>
        <br />
        <input id="evidence-title" type="text" required value={title} onChange={(e) => setTitle(e.target.value)} style={{ width: "100%" }} />
      </div>
      <div style={{ marginBottom: "0.75rem" }}>
        <label htmlFor="evidence-description">{t("form.descriptionLabel")}</label>
        <br />
        <textarea
          id="evidence-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          style={{ width: "100%" }}
        />
      </div>
      <div style={{ marginBottom: "0.75rem" }}>
        <label htmlFor="evidence-file">{t("form.fileLabel")}</label>
        <br />
        <input id="evidence-file" type="file" required onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
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
