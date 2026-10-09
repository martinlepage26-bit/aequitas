"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { coreAiGeneratedFieldsSchema, type ExplanationRecord } from "../../../../domain/explanationRecord";
import { validateConflictKnowledgeMap } from "../../../../domain/conflictKnowledge";

type Value = string | Value[] | { [key: string]: Value };
const enums: Record<string, string[]> = {
  assessment: ["reported", "supported", "contested", "unresolved"],
  independence: ["unknown", "shared_origin", "independent"],
  layer: ["material", "narrative", "relational"],
  field: ["title", "description", "body", "content"],
};
const templates: Record<string, Value> = {
  claims: { id: "", statement: "", type: "factual", citations: [], assessment: "unresolved", rationale: "", revision_conditions: "" },
  narratives: { id: "", interpretation: "", claim_ids: [], standpoint: "", assumptions: [] },
  contexts: { id: "", factor: "", layer: "relational", status: "hypothesis", claim_ids: [], citations: [], power_and_positionality: "", alternative_explanation: "", question_to_test: "" },
  experiences: { id: "", reported_impact: "", claim_ids: [], recognition_needs: "", disclosure_safeguards: "" },
  relationships: { from_id: "", to_id: "", type: "qualifies", status: "hypothesis", rationale: "" },
  repair_paths: { id: "", action: "", addresses_ids: [], prerequisites: [], consent_and_safety: "", accountable_role: "", review_conditions: "" },
  citations: { source_id: "", field: "body", excerpt: "" },
  evidence_citations: { evidence_item_id: "", relevance: "" },
  source_groups: { source_ids: [], independence: "unknown", rationale: "" },
};

export default function ReviewDraftForm({ caseId, recommendationId, explanation }: { caseId: string; recommendationId: string; explanation: ExplanationRecord }) {
  const t = useTranslations("knowledgeReview");
  const router = useRouter();
  const [draft, setDraft] = useState<Value>(() => coreAiGeneratedFieldsSchema.parse(explanation) as Value);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [changed, setChanged] = useState(false);
  const sources = explanation.knowledge_sources ?? [];

  function update(path: (string | number)[], value: Value) {
    setDraft(previous => {
      const copy = structuredClone(previous) as Record<string, Value>;
      let target = copy;
      for (const part of path.slice(0, -1)) target = target[part] as Record<string, Value>;
      target[path.at(-1)!] = value;
      return copy;
    });
    setChanged(true); setError("");
  }

  function field(value: Value, path: (string | number)[], name: string): ReactNode {
    const id = `review-${path.join("-")}`;
    const label = t(`fields.${name}`);
    if (Array.isArray(value)) return <fieldset key={id} style={{ margin: "0.75rem 0", padding: "0.75rem" }}>
      <legend>{label}</legend>
      {value.map((item, index) => <div key={`${id}-${index}`} style={{ marginBottom: "1rem" }}>
        {field(item, [...path, index], name)}
        <button type="button" onClick={() => update(path, value.filter((_, i) => i !== index))}>{t("remove", { label, index: index + 1 })}</button>
      </div>)}
      <button type="button" disabled={value.length >= 100} onClick={() => {
        const item = structuredClone(templates[name] ?? "");
        if (typeof item === "object" && !Array.isArray(item) && "id" in item) item.id = `node-${crypto.randomUUID()}`;
        update(path, [...value, item]);
      }}>{t("add", { label })}</button>
    </fieldset>;
    if (typeof value === "object") return <details key={id} open={path.length < 2} style={{ margin: "0.75rem 0" }}>
      <summary>{label}{"statement" in value && typeof value.statement === "string" ? `: ${value.statement.slice(0, 100)}` : ""}</summary>
      <div style={{ paddingLeft: "1rem" }}>{Object.entries(value).map(([key, child]) => field(child, [...path, key], key))}</div>
    </details>;
    if (name === "method_version" || name === "id") return <p key={id}><strong>{label}:</strong> {value}</p>;
    let options = enums[name];
    if (name === "type") options = path.includes("relationships") ? ["supports", "contradicts", "qualifies", "interprets", "experienced_by", "occurred_before", "caused_or_contributed_to", "amplified_by", "governed_by", "requires_review", "unresolved_with", "proposes_repair_for"] : ["factual", "causal", "moral", "identity", "policy", "experience"];
    if (name === "status") options = path.includes("relationships") ? ["reported", "hypothesis", "contested", "supported"] : ["documented", "hypothesis", "unknown"];
    if (name === "source_id" || name === "source_ids") return <p key={id}><label htmlFor={id}>{label}</label><br />
      <select id={id} value={value} required onChange={e => update(path, e.target.value)}>
        <option value="">{t("chooseSource")}</option>
        {sources.map(s => <option key={s.id} value={s.id}>{s.fields.title ?? s.submitted_by_role} · {s.record_id}</option>)}
      </select></p>;
    return <p key={id}><label htmlFor={id}>{label}</label><br />{options
      ? <select id={id} value={value} onChange={e => update(path, e.target.value)}>{options.map(option => <option key={option} value={option}>{t(`values.${option}`)}</option>)}</select>
      : <textarea id={id} value={value} rows={name.endsWith("_ids") || name.endsWith("_id") ? 1 : 3} maxLength={8000} onChange={e => update(path, e.target.value)} style={{ width: "100%" }} />
    }</p>;
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault(); setError("");
    const parsed = coreAiGeneratedFieldsSchema.safeParse(draft);
    if (!parsed.success) { setError(`${t("invalid")} ${parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ")}`); return; }
    const integrity = validateConflictKnowledgeMap(parsed.data.conflict_knowledge, sources);
    if (integrity) { setError(`${t("invalid")} ${integrity}`); return; }
    setBusy(true);
    try {
      const response = await fetch(`/api/cases/${caseId}/draft`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ recommendationId, explanation: parsed.data, reason }) });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        setError(body?.message ?? t("error"));
      } else { setChanged(false); router.refresh(); }
    } catch { setError(t("error")); }
    finally { setBusy(false); }
  }

  return <details style={{ marginTop: "1.5rem" }}><summary>{t("title")}</summary>
    <p>{t("help")}</p>
    <form onSubmit={submit}>
      <fieldset disabled={busy} style={{ border: 0, padding: 0 }}>
        {typeof draft === "object" && !Array.isArray(draft) && Object.entries(draft).map(([key, value]) => field(value, [key], key))}
        <p><label htmlFor="review-reason">{t("reason")}</label><br /><textarea id="review-reason" required maxLength={8000} value={reason} onChange={e => setReason(e.target.value)} style={{ width: "100%" }} /></p>
        <button type="submit" disabled={!changed || !reason.trim()}>{busy ? t("saving") : t("save")}</button>
      </fieldset>
      {error && <p role="alert" className="alert">{error}</p>}
    </form>
  </details>;
}
