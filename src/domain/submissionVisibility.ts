import type { CaseReadAccess } from "./caseAccess";
import { prisma } from "../lib/prisma";

/**
 * A party sees only the submissions they authored. Anyone else who already
 * passed the case read check (assigned mediator, approver, admin, or a
 * manager who may still claim an open case) keeps both sides.
 * Submissions are evidence, the position, and chronology entries.
 */
export function canReadPartySubmission(input: {
  access: CaseReadAccess | null;
  viewerId: string;
  authorId: string;
}): boolean {
  if (!input.access) return false;
  if (input.access !== "party") return true;
  return input.viewerId === input.authorId;
}

export interface HiddenSubmissionIds {
  evidenceIds: ReadonlySet<string>;
  positionIds: ReadonlySet<string>;
  chronologyIds: ReadonlySet<string>;
}

/** Identifiers of the other party's submissions. The text itself is not loaded. */
export async function hiddenSubmissionIds(caseId: string, viewerId: string): Promise<HiddenSubmissionIds> {
  const [evidence, positions, chronology] = await Promise.all([
    prisma.evidenceItem.findMany({ where: { caseId, submittedById: { not: viewerId } }, select: { id: true } }),
    prisma.positionStatement.findMany({ where: { caseId, partyId: { not: viewerId } }, select: { id: true } }),
    prisma.chronologyEntry.findMany({ where: { caseId, submittedById: { not: viewerId } }, select: { id: true } }),
  ]);
  return {
    evidenceIds: new Set(evidence.map((row) => row.id)),
    positionIds: new Set(positions.map((row) => row.id)),
    chronologyIds: new Set(chronology.map((row) => row.id)),
  };
}

export function sourceRecordIsHidden(kind: string, recordId: string, hidden: HiddenSubmissionIds): boolean {
  if (kind === "evidence_metadata" || kind === "evidence_content") return hidden.evidenceIds.has(recordId);
  if (kind === "position") return hidden.positionIds.has(recordId);
  if (kind === "chronology") return hidden.chronologyIds.has(recordId);
  return false;
}

const PARTY_RECORD_KINDS = new Set(["evidence_metadata", "evidence_content", "position", "chronology"]);

interface Citation {
  source_id: string;
  excerpt?: string;
}

interface KnowledgeClaim {
  id: string;
  citations: Citation[];
}

interface KnowledgeContext {
  id: string;
  citations?: Citation[];
}

interface KnowledgeRelationship {
  from_id: string;
  to_id: string;
}

interface KnowledgeMap {
  claims?: KnowledgeClaim[];
  contexts?: KnowledgeContext[];
  narratives?: unknown[];
  experiences?: unknown[];
  relationships?: KnowledgeRelationship[];
  triangulation?: {
    source_groups?: unknown[];
    data?: string;
    investigators?: string;
    theories?: string;
    methods?: string;
    missing_evidence?: string[];
  };
  synthesis?: {
    supported_claim_ids?: string[];
    disputed_claim_ids?: string[];
    unresolved_questions?: string[];
    conditional_account?: string;
    revision_conditions?: string;
  };
  repair_paths?: unknown[];
}

interface KnowledgeSource {
  id: string;
  kind: string;
  record_id: string;
}

interface PartyExplanation {
  summary?: string;
  proposed_outcome?: string;
  reasoning?: string;
  limits?: string[];
  not_considered?: string[];
  evidence_citations?: { evidence_item_id: string; relevance: string }[];
  claim_evidence?: { section: "summary" | "reasoning"; text: string; citation_ids: string[] }[];
  knowledge_sources?: KnowledgeSource[];
  conflict_knowledge?: KnowledgeMap | null;
}

function citationsAreSolelyOwn(citations: readonly Citation[] | undefined, ownSourceIds: ReadonlySet<string>): boolean {
  return Boolean(citations && citations.length > 0 && citations.every((citation) => ownSourceIds.has(citation.source_id)));
}

/**
 * A party sees an AI output only when every citation is one of their own
 * submissions. A missing source list, an empty one, or a list that is not
 * solely that party's evidence, position, and chronology is combined and
 * omitted rather than edited, so the other party's wording is not sent.
 * The assigned mediator, an approver, and an admin are not passed through here.
 */
export function filterExplanationForParty<T extends PartyExplanation>(explanation: T, hidden: HiddenSubmissionIds): T {
  const listed = explanation.knowledge_sources;
  // A missing or empty source list is not "no other party". Drafts are built
  // from both positions and every chronology entry, and historical records
  // may omit knowledge_sources. Treat that as combined.
  const sourcesKnown = Array.isArray(listed) && listed.length > 0;
  const sources = sourcesKnown ? listed : [];
  const ownSourceIds = new Set(
    sources
      .filter((source) => PARTY_RECORD_KINDS.has(source.kind) && !sourceRecordIsHidden(source.kind, source.record_id, hidden))
      .map((source) => source.id),
  );
  const citesOtherEvidence = (explanation.evidence_citations ?? []).some((citation) => hidden.evidenceIds.has(citation.evidence_item_id));
  const mixed = !sourcesKnown || citesOtherEvidence || sources.some((source) => !ownSourceIds.has(source.id));
  const map = explanation.conflict_knowledge;
  const claims = (map?.claims ?? []).filter((claim) => citationsAreSolelyOwn(claim.citations, ownSourceIds));
  const contexts = (map?.contexts ?? []).filter((context) => citationsAreSolelyOwn(context.citations, ownSourceIds));
  const visibleIds = new Set([...claims.map((claim) => claim.id), ...contexts.map((context) => context.id)]);
  const claimIds = new Set(claims.map((claim) => claim.id));
  const filteredMap = map
    ? mixed
      ? {
          ...map,
          claims,
          contexts,
          narratives: [],
          experiences: [],
          relationships: (map.relationships ?? []).filter((link) => visibleIds.has(link.from_id) && visibleIds.has(link.to_id)),
          triangulation: {
            source_groups: [],
            data: "",
            investigators: "",
            theories: "",
            methods: "",
            missing_evidence: [],
          },
          synthesis: {
            supported_claim_ids: (map.synthesis?.supported_claim_ids ?? []).filter((id) => claimIds.has(id)),
            disputed_claim_ids: (map.synthesis?.disputed_claim_ids ?? []).filter((id) => claimIds.has(id)),
            unresolved_questions: [],
            conditional_account: "",
            revision_conditions: "",
          },
          repair_paths: [],
        }
      : { ...map, claims, contexts }
    : map;
  const ownCitations = (explanation.evidence_citations ?? [])
    .filter((citation) => !hidden.evidenceIds.has(citation.evidence_item_id))
    .map((citation) => (mixed ? { ...citation, relevance: "" } : citation));
  return {
    ...explanation,
    ...(mixed ? { summary: "", proposed_outcome: "", reasoning: "", limits: [], not_considered: [] } : {}),
    ...(explanation.evidence_citations ? { evidence_citations: ownCitations } : {}),
    // Claim-to-source mappings belong to the staff-only shared summary.
    ...(explanation.claim_evidence ? { claim_evidence: [] } : {}),
    ...(explanation.knowledge_sources ? { knowledge_sources: sources.filter((source) => ownSourceIds.has(source.id)) } : {}),
    ...(map ? { conflict_knowledge: filteredMap } : {}),
  };
}

export interface SynthesisSentence {
  id: string;
  text: string;
}

/** Keep synthesis sentences whose sources are all the viewer's own submissions. */
export function filterSynthesisForParty<T extends SynthesisSentence>(
  sections: Record<string, T[]>,
  sentenceMap: readonly { sentenceId: string; sourceIds: readonly string[] }[],
  ownSourceIds: ReadonlySet<string>,
): Record<string, T[]> {
  const visible = new Set(
    sentenceMap
      .filter((entry) => entry.sourceIds.length > 0 && entry.sourceIds.every((id) => ownSourceIds.has(id)))
      .map((entry) => entry.sentenceId),
  );
  const filtered: Record<string, T[]> = {};
  for (const [name, sentences] of Object.entries(sections)) {
    filtered[name] = sentences.filter((sentence) => visible.has(sentence.id));
  }
  return filtered;
}
