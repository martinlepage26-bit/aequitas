"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import type { ConflictKnowledgeMap, KnowledgeSource } from "../../../../domain/conflictKnowledge";

export default function KnowledgeGraphExplorer({ map, sources }: { map: ConflictKnowledgeMap; sources: KnowledgeSource[] }) {
  const t = useTranslations("knowledgeGraph");
  const terms = useTranslations("knowledgeReview.values");
  const [selected, setSelected] = useState(map.claims[0]?.id ?? "");
  const groups = [
    { kind: "claims", nodes: map.claims.map(n => ({ id: n.id, label: n.statement })) },
    { kind: "narratives", nodes: map.narratives.map(n => ({ id: n.id, label: n.interpretation })) },
    { kind: "contexts", nodes: map.contexts.map(n => ({ id: n.id, label: n.factor })) },
    { kind: "experiences", nodes: map.experiences.map(n => ({ id: n.id, label: n.reported_impact })) },
    { kind: "repair", nodes: map.repair_paths.map(n => ({ id: n.id, label: n.action })) },
    { kind: "sources", nodes: sources.map(n => ({ id: n.id, label: n.fields.title ?? `${n.submitted_by_role} · v${n.version ?? "—"}` })) },
  ];
  const nodes = groups.flatMap(g => g.nodes);
  const label = (id: string) => nodes.find(n => n.id === id)?.label ?? id;
  const links = [
    ...map.relationships.map(r => ({ from: r.from_id, to: r.to_id, kind: terms(r.type), status: terms(r.status), text: r.rationale })),
    ...[...map.claims, ...map.contexts].flatMap(n => n.citations.map(q => ({ from: n.id, to: q.source_id, kind: t("cites"), status: q.field, text: q.excerpt }))),
    ...[...map.narratives, ...map.contexts, ...map.experiences].flatMap(n => n.claim_ids.map(id => ({ from: n.id, to: id, kind: t("references"), status: "", text: "" }))),
    ...map.repair_paths.flatMap(n => n.addresses_ids.map(id => ({ from: n.id, to: id, kind: terms("proposes_repair_for"), status: "", text: n.review_conditions }))),
  ].filter(e => e.from === selected || e.to === selected);
  const source = sources.find(s => s.id === selected);
  return <details><summary>{t("title")}</summary>
    <p>{t("help")}</p>
    <label htmlFor="knowledge-node">{t("select")}</label><br />
    <select id="knowledge-node" value={selected} onChange={e => setSelected(e.target.value)} style={{ maxWidth: "100%" }}>
      {groups.map(group => <optgroup key={group.kind} label={t(group.kind)}>{group.nodes.map(n => <option key={n.id} value={n.id}>{n.label}</option>)}</optgroup>)}
    </select>
    <div aria-live="polite">
      <h4>{label(selected)}</h4>
      <p>{t("reference", { id: selected })}</p>
      {links.length === 0 && <p>{t("noLinks")}</p>}
      <ul>{links.map((edge, i) => <li key={i} style={{ marginBottom: "1rem" }}>
        <button type="button" onClick={() => setSelected(edge.from)}>{label(edge.from)}</button>
        {" → "}{edge.kind}{edge.status ? ` (${edge.status})` : ""}{" → "}
        <button type="button" onClick={() => setSelected(edge.to)}>{label(edge.to)}</button>
        {edge.text && <p style={{ whiteSpace: "pre-wrap" }}>{edge.text}</p>}
      </li>)}</ul>
      {source && <section><h5>{t("original")}</h5>
        <p>{source.submitted_by_role} · {source.created_at ?? "—"} · {source.locale ?? "—"}</p>
        {source.sha256 && <p style={{ overflowWrap: "anywhere" }}>SHA-256: {source.sha256}</p>}
        {source.extraction && <p>{source.extraction.method} · {source.extraction.status}: {source.extraction.note}</p>}
        {Object.entries(source.fields).map(([name, value]) => value && <div key={name}><h6>{terms(name)}</h6><p lang={source.locale ?? undefined} style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{value}</p></div>)}
      </section>}
    </div>
  </details>;
}
