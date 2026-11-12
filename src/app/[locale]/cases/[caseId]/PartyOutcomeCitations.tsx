"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import styles from "./workspace.module.css";

export interface PartyOutcomeCitationView {
  id: string;
  evidenceItemId: string;
  evidenceTitle: string;
  relevance: string;
}

export default function PartyOutcomeCitations({
  caseId,
  outcomeId,
  citations,
}: {
  caseId: string;
  outcomeId: string;
  citations: PartyOutcomeCitationView[];
}) {
  const t = useTranslations("workspace.partyOutcome");
  if (citations.length === 0) return null;

  return (
    <section aria-label={t("citationHeading")}>
      <h4>{t("citationHeading")}</h4>
      <ul>
        {citations.map((citation) => (
          <Citation key={citation.id} caseId={caseId} outcomeId={outcomeId} citation={citation} />
        ))}
      </ul>
    </section>
  );
}

function Citation({ caseId, outcomeId, citation }: { caseId: string; outcomeId: string; citation: PartyOutcomeCitationView }) {
  const t = useTranslations("workspace.partyOutcome");
  const [excerpt, setExcerpt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  async function toggleExcerpt() {
    if (excerpt !== null) {
      setExcerpt(null);
      setError(false);
      return;
    }
    setBusy(true);
    setError(false);
    try {
      const response = await fetch(`/api/cases/${caseId}/party-outcomes/${outcomeId}/citations/${citation.id}`, { cache: "no-store" });
      if (!response.ok) throw new Error("citation unavailable");
      const body = await response.json() as { excerpt?: unknown };
      if (typeof body.excerpt !== "string" || body.excerpt.length === 0) throw new Error("citation unavailable");
      setExcerpt(body.excerpt);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li>
      <a href={`#evidence-${citation.evidenceItemId}`}>{citation.evidenceTitle}</a>
      {citation.relevance && <p>{citation.relevance}</p>}
      <button type="button" onClick={toggleExcerpt} disabled={busy}>
        {busy ? t("loadingExcerpt") : excerpt !== null ? t("hideExcerpt") : t("viewExcerpt")}
      </button>
      {error && <p role="alert" className={styles.hint}>{t("excerptUnavailable")}</p>}
      {excerpt !== null && <blockquote>{excerpt}</blockquote>}
    </li>
  );
}
