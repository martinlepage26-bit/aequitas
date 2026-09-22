import { z } from "zod";

/** Product method derived from Aequitas Core.txt, not an externally verified research corpus. */
export const KNOWLEDGE_METHOD_VERSION = "aequitas-core-v1";
const text = z.string().trim().min(1).max(8000);
const ids = z.array(text).max(100);
const citation = z.object({
  source_id: text,
  field: z.enum(["title", "description", "body", "content"]),
  excerpt: text,
});

export const conflictKnowledgeMapSchema = z.object({
  method_version: z.literal(KNOWLEDGE_METHOD_VERSION),
  claims: z.array(z.object({
    id: text,
    statement: text,
    type: z.enum(["factual", "causal", "moral", "identity", "policy", "experience"]),
    citations: z.array(citation).min(1).max(30),
    assessment: z.enum(["reported", "supported", "contested", "unresolved"]),
    rationale: text,
    revision_conditions: text,
  })).min(1).max(100),
  narratives: z.array(z.object({
    id: text, interpretation: text, claim_ids: ids.min(1),
    standpoint: text, assumptions: z.array(text).max(30),
  })).min(2).max(30),
  contexts: z.array(z.object({
    id: text,
    factor: text,
    layer: z.enum(["material", "narrative", "relational"]),
    status: z.enum(["documented", "hypothesis", "unknown"]),
    claim_ids: ids,
    citations: z.array(citation).max(30),
    power_and_positionality: text,
    alternative_explanation: text,
    question_to_test: text,
  })).min(1).max(30),
  experiences: z.array(z.object({
    id: text, reported_impact: text, claim_ids: ids.min(1),
    recognition_needs: text, disclosure_safeguards: text,
  })).max(30),
  relationships: z.array(z.object({
    from_id: text, to_id: text,
    type: z.enum(["supports", "contradicts", "qualifies", "interprets", "experienced_by", "occurred_before", "caused_or_contributed_to", "amplified_by", "governed_by", "requires_review", "unresolved_with", "proposes_repair_for"]),
    status: z.enum(["reported", "hypothesis", "contested", "supported"]),
    rationale: text,
  })).max(200),
  triangulation: z.object({
    source_groups: z.array(z.object({
      source_ids: ids.min(1),
      independence: z.enum(["unknown", "shared_origin", "independent"]),
      rationale: text,
    })).min(1).max(100),
    data: text, investigators: text, theories: text, methods: text,
    missing_evidence: z.array(text).min(1).max(30),
  }),
  synthesis: z.object({
    supported_claim_ids: ids,
    disputed_claim_ids: ids,
    unresolved_questions: z.array(text).min(1).max(30),
    conditional_account: text,
    revision_conditions: text,
  }),
  repair_paths: z.array(z.object({
    id: text, action: text, addresses_ids: ids.min(1),
    prerequisites: z.array(text).min(1).max(30),
    consent_and_safety: text,
    accountable_role: text,
    review_conditions: text,
  })).min(1).max(30),
});

export type ConflictKnowledgeMap = z.infer<typeof conflictKnowledgeMapSchema>;
export const knowledgeSourceSchema = z.object({
  id: text,
  kind: z.enum(["evidence_metadata", "evidence_content", "position", "legal_research"]),
  record_id: text,
  version: z.number().int().positive().nullable(),
  locale: text.nullable(),
  submitted_by_role: text,
  created_at: z.string().datetime().nullable(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  extraction: z.object({
    status: z.enum(["extracted", "bounded", "empty", "unsupported", "unavailable"]),
    method: z.enum(["utf8", "pdftotext", "tesseract", "none"]),
    note: text,
  }).optional(),
  fields: z.object({ content: z.string().optional(), title: z.string().optional(), description: z.string().optional(), body: z.string().optional() }),
});
export type KnowledgeSource = z.infer<typeof knowledgeSourceSchema>;


/** Exact excerpts prove traceability only; humans still assess relevance and independence. */
export function validateConflictKnowledgeMap(value: unknown, sources: KnowledgeSource[]): string | null {
  const registry = z.array(knowledgeSourceSchema).safeParse(sources);
  if (!registry.success) return "Invalid source provenance registry.";
  const parsed = conflictKnowledgeMapSchema.safeParse(value);
  if (!parsed.success) return parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ");
  const map = parsed.data;
  const sourceById = new Map(sources.map(s => [s.id, s]));
  if (sourceById.size !== sources.length) return "Duplicate source IDs.";
  const nodes = [...map.claims, ...map.narratives, ...map.contexts, ...map.experiences, ...map.repair_paths];
  const nodeIds = new Set(nodes.map(n => n.id));
  if (nodeIds.size !== nodes.length) return "Duplicate graph node IDs.";
  const claimById = new Map(map.claims.map(c => [c.id, c]));
  for (const node of [...map.claims, ...map.contexts]) {
    if ("status" in node && node.status === "documented" && !node.citations.length) return "Documented context requires a citation.";
    for (const cite of node.citations) {
      const original = sourceById.get(cite.source_id)?.fields[cite.field];
      if (!original || !original.includes(cite.excerpt)) return `Unresolvable exact excerpt: ${cite.source_id}.${cite.field}`;
    }
  }
  for (const node of [...map.narratives, ...map.contexts, ...map.experiences]) {
    if (node.claim_ids.some(id => !claimById.has(id))) return `Unknown claim reference in ${node.id}.`;
  }
  for (const experience of map.experiences) {
    if (experience.claim_ids.some(id => claimById.get(id)?.type !== "experience")) return "Reported impacts must reference experience claims.";
  }
  for (const edge of map.relationships) {
    if (!nodeIds.has(edge.from_id) || !nodeIds.has(edge.to_id)) return "Dangling graph relationship.";
    if (edge.from_id === edge.to_id) return "Self-referential graph relationship.";
  }
  for (const path of map.repair_paths) {
    if (path.addresses_ids.some(id => !nodeIds.has(id) || id === path.id)) return "Repair path references an unknown or self node.";
  }
  for (const [list, assessment] of [[map.synthesis.supported_claim_ids, "supported"], [map.synthesis.disputed_claim_ids, "contested"]] as const) {
    if (list.some(id => claimById.get(id)?.assessment !== assessment)) return "Synthesis must preserve claim assessments.";
  }
  const grouped = new Set<string>();
  const groupByHash = new Map<string, number>();
  for (const [index, group] of map.triangulation.source_groups.entries()) {
    for (const id of group.source_ids) {
      if (!sourceById.has(id)) return "Unknown triangulation source.";
      if (grouped.has(id)) return "A source cannot count as multiple independent pathways.";
      grouped.add(id);
      const hash = sourceById.get(id)?.sha256;
      if (hash) {
        const prior = groupByHash.get(hash);
        if (prior !== undefined && prior !== index) return "Identical evidence files must share one source group.";
        groupByHash.set(hash, index);
      }
    }
  }
  const cited = [...map.claims, ...map.contexts].flatMap(n => n.citations.map(c => c.source_id));
  if (cited.some(id => !grouped.has(id))) return "Every cited source needs an independence assessment.";
  return null;
}
