import { absoluteClaimHit } from "./absoluteClaims";

export const SYNTHESIS_SECTIONS = ["established", "disputed", "unknown", "actionable", "reviewable"] as const;
export type SynthesisSection = (typeof SYNTHESIS_SECTIONS)[number];

export const DIAG_E = ["insufficient", "single_source", "corroborated", "disputed_present"] as const;
export const DIAG_P = ["positionality_gap", "positionality_recorded"] as const;
export const DIAG_C = ["third_factor_missing", "third_factor_recorded"] as const;

export interface SynthesisSentence {
  id: string;
  text: string;
}

export interface SentenceProvenance {
  sentenceId: string;
  claimIds: string[];
  sourceIds: string[];
}

export interface SynthesisDraft {
  sections: Record<SynthesisSection, SynthesisSentence[]>;
  sentence_map: SentenceProvenance[];
  diag_e: string;
  diag_p: string;
  diag_c: string;
}

export interface SynthesisClaim {
  id: string;
  text: string;
  claimType: string;
  confidence: string;
  status: string;
  doNotSummarizeAsSettled: boolean;
}

export interface SynthesisLink {
  claimId: string;
  sourceId: string;
  excerpt: string;
}

const emptySections = (): SynthesisDraft["sections"] => ({
  established: [],
  disputed: [],
  unknown: [],
  actionable: [],
  reviewable: [],
});

function isDisputed(claim: { confidence: string; status: string }): boolean {
  return claim.confidence === "DISPUTED" || claim.status === "DISPUTED";
}

function sectionFor(claim: SynthesisClaim): SynthesisSection {
  if (isDisputed(claim)) return "disputed";
  if (claim.claimType === "IMPACT_STATEMENT" || claim.claimType === "MORAL" || claim.doNotSummarizeAsSettled) return "reviewable";
  if (claim.claimType === "POLICY") return "actionable";
  if (claim.confidence === "ESTABLISHED") return "established";
  return "unknown";
}

export function assembleSynthesis(input: {
  claims: SynthesisClaim[];
  links: SynthesisLink[];
  hasContextFactor: boolean;
}): SynthesisDraft {
  const sections = emptySections();
  const sentence_map: SentenceProvenance[] = [];
  const linksByClaim = new Map<string, SynthesisLink[]>();
  for (const link of input.links) {
    if (!link.excerpt.trim()) continue;
    const list = linksByClaim.get(link.claimId) ?? [];
    list.push(link);
    linksByClaim.set(link.claimId, list);
  }

  for (const claim of input.claims) {
    const links = linksByClaim.get(claim.id) ?? [];
    if (links.length === 0) continue;
    const sentenceId = `s-${claim.id}`;
    sections[sectionFor(claim)].push({ id: sentenceId, text: claim.text });
    sentence_map.push({
      sentenceId,
      claimIds: [claim.id],
      sourceIds: [...new Set(links.map((link) => link.sourceId))],
    });
  }

  const establishedSources = new Map<string, Set<string>>();
  for (const entry of sentence_map) {
    const sentence = sections.established.find((item) => item.id === entry.sentenceId);
    if (!sentence) continue;
    const claimId = entry.claimIds[0];
    if (!claimId) continue;
    establishedSources.set(claimId, new Set(entry.sourceIds));
  }

  let diag_e: (typeof DIAG_E)[number] = "insufficient";
  if (sections.disputed.length > 0) diag_e = "disputed_present";
  else if ([...establishedSources.values()].some((sources) => sources.size >= 2)) diag_e = "corroborated";
  else if (sentence_map.some((entry) => entry.sourceIds.length === 1)) diag_e = "single_source";

  const diag_p = input.claims.some((claim) => claim.claimType === "IDENTITY" && (linksByClaim.get(claim.id)?.length ?? 0) > 0)
    ? "positionality_recorded"
    : "positionality_gap";
  const diag_c = input.hasContextFactor ? "third_factor_recorded" : "third_factor_missing";

  return { sections, sentence_map, diag_e, diag_p, diag_c };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function validateSynthesis(
  draft: unknown,
  context: { claims: Array<{ id: string; confidence: string; status: string }>; sourceIds: ReadonlySet<string> },
): { ok: true } | { ok: false; reasons: string[] } {
  const reasons: string[] = [];
  const record = asRecord(draft);
  if (!record) return { ok: false, reasons: ["A synthesis must be an object with sections, a sentence map, and diagnostic flags."] };

  const sections = asRecord(record.sections);
  if (!sections) reasons.push("A synthesis needs the sections established, disputed, unknown, actionable, and reviewable.");

  const parsedSections = emptySections();
  if (sections) {
    for (const name of SYNTHESIS_SECTIONS) {
      const value = sections[name];
      if (!Array.isArray(value)) {
        reasons.push(`The ${name} section is missing.`);
        continue;
      }
      parsedSections[name] = value.map((item, index) => {
        const sentence = asRecord(item);
        const id = typeof sentence?.id === "string" ? sentence.id : "";
        const text = typeof sentence?.text === "string" ? sentence.text : "";
        if (!id) reasons.push(`A sentence in ${name} is missing an id.`);
        if (item && (typeof item !== "object" || typeof (item as { text?: unknown }).text !== "string")) {
          reasons.push(`A sentence in ${name} at position ${index + 1} is not text.`);
        }
        return { id, text };
      });
    }
  }

  for (const key of ["diag_e", "diag_p", "diag_c"] as const) {
    if (typeof record[key] !== "string") reasons.push("Diagnostic flags are flags, not numeric scores.");
  }
  if (typeof record.diag_e === "string" && !DIAG_E.includes(record.diag_e as (typeof DIAG_E)[number])) {
    reasons.push("The evidence flag is not one of the allowed flags.");
  }
  if (typeof record.diag_p === "string" && !DIAG_P.includes(record.diag_p as (typeof DIAG_P)[number])) {
    reasons.push("The positionality flag is not one of the allowed flags.");
  }
  if (typeof record.diag_c === "string" && !DIAG_C.includes(record.diag_c as (typeof DIAG_C)[number])) {
    reasons.push("The context flag is not one of the allowed flags.");
  }

  const map = Array.isArray(record.sentence_map) ? record.sentence_map : null;
  if (!map) reasons.push("A synthesis needs a sentence map.");
  const provenance = new Map<string, { claimIds: string[]; sourceIds: string[] }>();
  const claimIds = new Set(context.claims.map((claim) => claim.id));
  if (map) {
    for (const entry of map) {
      const row = asRecord(entry);
      const sentenceId = typeof row?.sentenceId === "string" ? row.sentenceId : "";
      const linkedClaims = Array.isArray(row?.claimIds) ? row.claimIds.filter((id): id is string => typeof id === "string") : [];
      const linkedSources = Array.isArray(row?.sourceIds) ? row.sourceIds.filter((id): id is string => typeof id === "string") : [];
      if (!sentenceId) {
        reasons.push("A sentence map entry is missing a sentence id.");
        continue;
      }
      for (const claimId of linkedClaims) {
        if (!claimIds.has(claimId)) reasons.push("A provenance link names a claim that is not on this case.");
      }
      for (const sourceId of linkedSources) {
        if (!context.sourceIds.has(sourceId)) reasons.push("A provenance link names a source that is not on this case.");
      }
      provenance.set(sentenceId, { claimIds: linkedClaims, sourceIds: linkedSources });
    }
  }

  const referenced = new Set<string>();
  for (const name of SYNTHESIS_SECTIONS) {
    for (const sentence of parsedSections[name]) {
      const text = sentence.text.trim();
      if (!text) continue;
      const hit = absoluteClaimHit(text);
      if (hit) reasons.push("A synthesis sentence uses an absolute claim.");
      const links = sentence.id ? provenance.get(sentence.id) : undefined;
      const usable = (links?.claimIds.length ?? 0) + (links?.sourceIds.length ?? 0);
      if (usable === 0) reasons.push("A material sentence has no provenance link.");
      for (const claimId of links?.claimIds ?? []) referenced.add(claimId);
    }
  }

  const disputedSectionClaimIds = new Set<string>();
  for (const sentence of parsedSections.disputed) {
    for (const claimId of provenance.get(sentence.id)?.claimIds ?? []) disputedSectionClaimIds.add(claimId);
  }
  for (const claim of context.claims) {
    if (!isDisputed(claim) || !referenced.has(claim.id)) continue;
    if (!disputedSectionClaimIds.has(claim.id)) {
      reasons.push("A disputed claim is referenced without appearing in the disputed section.");
    }
  }

  const unique = [...new Set(reasons)];
  return unique.length === 0 ? { ok: true } : { ok: false, reasons: unique };
}
