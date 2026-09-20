import KnowledgeGraphExplorer from "./KnowledgeGraphExplorer";
import { getTranslations } from "next-intl/server";
import type { ConflictKnowledgeMap, KnowledgeSource } from "../../../../domain/conflictKnowledge";

export default async function ConflictKnowledgeView({ map, sources }: { map: ConflictKnowledgeMap; sources: KnowledgeSource[] }) {
  const t = await getTranslations("knowledgeMap");
  const claimText = (ids: string[]) => ids.map(id => map.claims.find(c => c.id === id)?.statement ?? id).join(" · ");
  const excerpts = (citations: ConflictKnowledgeMap["claims"][number]["citations"]) => citations.map((c, i) => {
    const source = sources.find(s => s.id === c.source_id);
    return <blockquote key={i} lang={source?.locale ?? undefined}>
      <p>{c.excerpt}</p>
      <footer>{source?.fields.title ?? t("position")} · {t("sourceVersion", { version: source?.version ?? "—" })}</footer>
    </blockquote>;
  });
  return <section aria-labelledby="knowledge-map-heading">
    <h3 id="knowledge-map-heading">{t("title")}</h3>
    <p>{t("limits")}</p>
    <KnowledgeGraphExplorer map={map} sources={sources} />
    <details open><summary>{t("claims")}</summary>
      {map.claims.map(c => <article key={c.id}>
        <h4>{c.statement}</h4>
        <p>{t(`types.${c.type}`)} · {t(`assessments.${c.assessment}`)}</p>
        <p>{c.rationale}</p>{excerpts(c.citations)}
        <p><strong>{t("revision")}:</strong> {c.revision_conditions}</p>
      </article>)}
    </details>
    <details><summary>{t("narratives")}</summary>
      {map.narratives.map(n => <article key={n.id}><h4>{n.interpretation}</h4><p>{n.standpoint}</p><p>{claimText(n.claim_ids)}</p><ul>{n.assumptions.map((a, i) => <li key={i}>{a}</li>)}</ul></article>)}
    </details>
    <details><summary>{t("contexts")}</summary>
      {map.contexts.map(c => <article key={c.id}><h4>{c.factor}</h4><p>{t(`layers.${c.layer}`)} · {t(`assessments.${c.status}`)}</p><p>{c.power_and_positionality}</p><p>{c.alternative_explanation}</p><p>{c.question_to_test}</p><p>{claimText(c.claim_ids)}</p>{excerpts(c.citations)}</article>)}
    </details>
    <details><summary>{t("experiences")}</summary>
      {map.experiences.map(e => <article key={e.id}><h4>{e.reported_impact}</h4><p>{claimText(e.claim_ids)}</p><p>{e.recognition_needs}</p><p>{e.disclosure_safeguards}</p></article>)}
      {map.experiences.length === 0 && <p>{t("noExperience")}</p>}
    </details>
    <details><summary>{t("triangulation")}</summary>
      <p>{map.triangulation.data}</p><p>{map.triangulation.investigators}</p><p>{map.triangulation.theories}</p><p>{map.triangulation.methods}</p>
      {map.triangulation.source_groups.map((g, i) => <p key={i}>{t(`assessments.${g.independence}`)}: {g.rationale}</p>)}
      <ul>{map.triangulation.missing_evidence.map((e, i) => <li key={i}>{e}</li>)}</ul>
    </details>
    <details open><summary>{t("synthesis")}</summary><p>{map.synthesis.conditional_account}</p>
      <p>{claimText(map.synthesis.supported_claim_ids)}</p><p>{claimText(map.synthesis.disputed_claim_ids)}</p>
      <ul>{map.synthesis.unresolved_questions.map((q, i) => <li key={i}>{q}</li>)}</ul>
      <p><strong>{t("revision")}:</strong> {map.synthesis.revision_conditions}</p>
    </details>
    <details><summary>{t("repair")}</summary>
      {map.repair_paths.map(r => <article key={r.id}><h4>{r.action}</h4><p>{r.accountable_role}</p><ul>{r.prerequisites.map((p, i) => <li key={i}>{p}</li>)}</ul><p>{r.consent_and_safety}</p><p>{r.review_conditions}</p></article>)}
    </details>
  </section>;
}
