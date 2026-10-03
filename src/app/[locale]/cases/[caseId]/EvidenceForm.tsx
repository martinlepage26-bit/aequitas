"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { EVIDENCE_KINDS } from "../../../../domain/evidenceKinds";
import styles from "./workspace.module.css";

export default function EvidenceForm({ caseId, disabled = false }: { caseId: string; disabled?: boolean }) {
  const t = useTranslations("workspace.evidence");
  const router = useRouter();
  const [kind, setKind] = useState(EVIDENCE_KINDS[0]);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<{ kind: "idle" | "busy" | "error" | "success"; message?: string }>({ kind: "idle" });

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!file || disabled || status.kind === "busy") return;
    setStatus({ kind: "busy" });

    const form = new FormData();
    form.set("kind", kind);
    form.set("title", title);
    if (description) form.set("description", description);
    form.set("file", file);

    try {
      const res = await fetch(`/api/cases/${caseId}/evidence`, { method: "POST", body: form });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setStatus({ kind: "error", message: data.message || t("form.error") });
        return;
      }

      setTitle("");
      setDescription("");
      setFile(null);
      if (fileInput.current) fileInput.current.value = "";
      setStatus({ kind: "success" });
      router.refresh();
    } catch {
      setStatus({ kind: "error", message: t("form.error") });
    }
  }

  return (
    <form onSubmit={handleSubmit} className={styles.form} aria-label={t("form.submit")} aria-describedby="evidence-guidance">
      <fieldset disabled={disabled || status.kind === "busy"}>
      <div className={styles.formRow}>
        <label htmlFor="evidence-kind">{t("form.kindLabel")}</label>
        <select id="evidence-kind" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
          {EVIDENCE_KINDS.map((k) => (
            <option key={k} value={k}>
              {t(`kind.${k}`)}
            </option>
          ))}
        </select>
      </div>
      <div className={styles.formRow}>
        <label htmlFor="evidence-title">{t("form.titleLabel")}</label>
        <input id="evidence-title" type="text" required value={title} onChange={(e) => setTitle(e.target.value)} style={{ width: "100%" }} />
      </div>
      <div className={styles.formRow}>
        <label htmlFor="evidence-description">{t("form.descriptionLabel")}</label>
        <textarea
          id="evidence-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          style={{ width: "100%" }}
        />
      </div>
      <div className={styles.formRow}>
        <label htmlFor="evidence-file">{t("form.fileLabel")}</label>
        <input id="evidence-file" ref={fileInput} type="file" required aria-describedby="evidence-file-hint" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <p id="evidence-file-hint" className={styles.hint}>{t("form.fileHint")}</p>
      </div>
      <button type="submit" disabled={status.kind === "busy"}>
        {status.kind === "busy" ? t("form.submitting") : t("form.submit")}
      </button>
      </fieldset>
      {status.kind === "error" && (
        <p role="alert" className={styles.error}>
          {status.message}
        </p>
      )}
      <p role="status" className={styles.hint}>{status.kind === "success" ? t("form.success") : ""}</p>
    </form>
  );
}
