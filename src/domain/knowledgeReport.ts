import type { ConflictKnowledgeMap, KnowledgeSource } from "./conflictKnowledge";

/** Complete, deterministic text representation shared by the sealed PDF and tests. */
export function knowledgeReportLines(map: ConflictKnowledgeMap, sources: KnowledgeSource[]): string[] {
  const lines = ["Conflict knowledge map / Carte des connaissances du conflit", `Method / Méthode: ${map.method_version}`];
  const references = (ids: string[]) => ids.join(", ") || "—";
  for (const c of map.claims) {
    lines.push(`[${c.id}] ${c.type} · ${c.assessment}: ${c.statement}`, c.rationale, `Revision / Révision: ${c.revision_conditions}`);
    for (const q of c.citations) lines.push(`Source ${q.source_id}.${q.field}: « ${q.excerpt} »`);
  }
  lines.push("Competing interpretations / Interprétations concurrentes");
  for (const n of map.narratives) lines.push(`[${n.id}] ${n.interpretation}`, n.standpoint, `Claims / Affirmations: ${references(n.claim_ids)}`, ...n.assumptions);
  lines.push("Context and power / Contexte et pouvoir");
  for (const c of map.contexts) {
    lines.push(`[${c.id}] ${c.layer} · ${c.status}: ${c.factor}`, c.power_and_positionality, c.alternative_explanation, c.question_to_test, `Claims / Affirmations: ${references(c.claim_ids)}`);
    for (const q of c.citations) lines.push(`Source ${q.source_id}.${q.field}: « ${q.excerpt} »`);
  }
  lines.push("Reported experience / Vécu rapporté");
  for (const e of map.experiences) lines.push(`[${e.id}] ${e.reported_impact}`, `Claims / Affirmations: ${references(e.claim_ids)}`, e.recognition_needs, e.disclosure_safeguards);
  lines.push("Relationships / Relations");
  for (const r of map.relationships) lines.push(`${r.from_id} → ${r.to_id}: ${r.type} · ${r.status}`, r.rationale);
  lines.push("Triangulation / Triangulation", map.triangulation.data, map.triangulation.investigators, map.triangulation.theories, map.triangulation.methods);
  for (const g of map.triangulation.source_groups) lines.push(`${references(g.source_ids)} · ${g.independence}`, g.rationale);
  lines.push(...map.triangulation.missing_evidence, "Conditional synthesis / Synthèse conditionnelle", map.synthesis.conditional_account,
    `Supported / Appuyé: ${references(map.synthesis.supported_claim_ids)}`, `Contested / Contesté: ${references(map.synthesis.disputed_claim_ids)}`,
    ...map.synthesis.unresolved_questions, map.synthesis.revision_conditions);
  lines.push("Repair paths / Pistes de réparation");
  for (const r of map.repair_paths) lines.push(`[${r.id}] ${r.action}`, `Addresses / Concerne: ${references(r.addresses_ids)}`, ...r.prerequisites, r.accountable_role, r.consent_and_safety, r.review_conditions);
  lines.push("Source snapshots / Sources conservées");
  for (const s of sources) {
    lines.push(`[${s.id}] ${s.kind} · ${s.record_id} · v${s.version ?? "—"} · ${s.locale ?? "—"}`, `${s.submitted_by_role} · ${s.created_at ?? "—"}`, `SHA-256: ${s.sha256 ?? "—"}`);
    if (s.extraction) lines.push(`${s.extraction.method} · ${s.extraction.status}`, s.extraction.note);
    for (const [field, value] of Object.entries(s.fields)) if (value) lines.push(`${field}: ${value}`);
  }
  return lines;
}
