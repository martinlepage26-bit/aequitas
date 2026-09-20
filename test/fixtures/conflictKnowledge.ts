import type { ConflictKnowledgeMap, KnowledgeSource } from "../../src/domain/conflictKnowledge";

export const sources: KnowledgeSource[] = [
  { id: "position:p1", kind: "position", record_id: "p1", version: 1, locale: "fr-CA", submitted_by_role: "complainant", created_at: null, sha256: null, fields: { body: "Je me suis senti humilié. La politique a changé." } },
  { id: "position:p2", kind: "position", record_id: "p2", version: 2, locale: "en-CA", submitted_by_role: "respondent", created_at: null, sha256: null, fields: { body: "The policy has not changed." } },
];
export function validMap(): ConflictKnowledgeMap {
  return {
    method_version: "aequitas-core-v1",
    claims: [
      { id: "c1", statement: "A participant reports humiliation.", type: "experience", assessment: "reported", citations: [{ source_id: "position:p1", field: "body", excerpt: "Je me suis senti humilié." }], rationale: "First-person report; cause is unresolved.", revision_conditions: "Participant clarification." },
      { id: "c2", statement: "The policy has changed.", type: "factual", assessment: "contested", citations: [{ source_id: "position:p1", field: "body", excerpt: "La politique a changé." }, { source_id: "position:p2", field: "body", excerpt: "The policy has not changed." }], rationale: "Accounts disagree.", revision_conditions: "Obtain dated policy versions." },
    ],
    narratives: [
      { id: "n1", interpretation: "The complainant links the incident to a policy change.", claim_ids: ["c1", "c2"], standpoint: "Affected participant.", assumptions: ["Policy change may explain the incident."] },
      { id: "n2", interpretation: "The respondent disputes a policy change.", claim_ids: ["c2"], standpoint: "Responding participant.", assumptions: ["Written policy and practice may differ."] },
    ],
    contexts: [{ id: "ctx1", factor: "Possible communication gap.", layer: "relational", status: "hypothesis", claim_ids: ["c2"], citations: [], power_and_positionality: "Access to policy records is unknown.", alternative_explanation: "Practice may have changed independently of written policy.", question_to_test: "Who received which policy version?" }],
    experiences: [{ id: "x1", reported_impact: "Humiliation.", claim_ids: ["c1"], recognition_needs: "Acknowledge the report without inferring cause.", disclosure_safeguards: "Further disclosure is voluntary." }],
    relationships: [{ from_id: "n2", to_id: "c2", type: "contradicts", status: "contested", rationale: "Respondent disputes the reported change." }],
    triangulation: { source_groups: sources.map(s => ({ source_ids: [s.id], independence: "unknown", rationale: "Underlying origin has not been independently checked." })), data: "Two party statements.", investigators: "No independent investigation.", theories: "Policy change and communication gap remain alternatives.", methods: "Statements only; no archival comparison.", missing_evidence: ["Dated policy records."] },
    synthesis: { supported_claim_ids: [], disputed_claim_ids: ["c2"], unresolved_questions: ["Did practice change?"], conditional_account: "Impact is reported; the policy change is disputed.", revision_conditions: "Review dated records." },
    repair_paths: [{ id: "r1", action: "Invite voluntary clarification and review policy records.", addresses_ids: ["c2", "x1"], prerequisites: ["Participant consent and authorized access to records."], consent_and_safety: "No compelled disclosure or reconciliation.", accountable_role: "Assigned case manager.", review_conditions: "Revisit when records are available." }],
  };
}
