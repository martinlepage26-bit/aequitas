import { z } from "zod";
import { scanForForbiddenContent } from "../explanationRecord";
import { proposalProblem, proposalSchema } from "./proposal";

/**
 * Deterministic checks on what the model returns. The model is untrusted:
 * nothing it writes reaches a party unless every check here passes, and a
 * failed check hands the case to a person instead of retrying silently.
 *
 * These checks are conservative heuristics. They cannot prove that free
 * text is neutral, accurate, or free of the other party's information; they
 * reject the patterns the program has ruled out.
 */

export const AGENT_PROMPT_VERSION = "case-agent-2026-11-06.1";
export const MAX_CITATION_EXCERPT_CHARACTERS = 1000;

const text = (max: number) => z.string().trim().min(1).max(max);
const ids = z.array(z.string().uuid()).max(50);
const citationIds = z.array(z.string().regex(/^C[1-9]\d{0,2}$/)).min(1).max(10);
const linkedClaim = z.object({
  text: text(500),
  citation_ids: citationIds,
}).strict();

export const agentOutputSchema = z.object({
  needs_human: z.string().trim().max(500).nullable(),
  summary_claims: z.array(linkedClaim).min(1).max(8),
  reasoning_claims: z.array(linkedClaim).min(1).max(10),
  limits: z.array(text(500)).min(1).max(10),
  not_considered: z.array(text(500)).min(1).max(10),
  citations: z.array(z.object({
    citation_id: z.string().regex(/^C[1-9]\d{0,2}$/),
    evidence_item_id: z.string().uuid(),
    relevance: text(500),
    excerpt: z.string().min(12).max(MAX_CITATION_EXCERPT_CHARACTERS).refine((value) => value.trim().length > 0),
  }).strict()).min(1).max(50),
  // Parties never read model text: the proposal is a closed choice rendered
  // by fixed templates, and each side lists its own evidence relied on.
  proposal: proposalSchema,
  party_evidence: z.object({ complainant: ids.min(1), respondent: ids.min(1) }).strict(),
}).strict();

export type AgentOutput = z.infer<typeof agentOutputSchema>;

/**
 * Phrases the agent must not use: verdicts on truthfulness or credibility,
 * statements of what the law requires, binding or pressuring language.
 * Matched case-insensitively in English and French.
 */
const AGENT_DENY: RegExp[] = [
  /\b(credib\w*|crédib\w*|lying|liar|menteu\w*|menso\w*|dishonest\w*|malhonn\w*|truthful|véridique)\b/i,
  /\b(probab\w*|likelihood|vraisemblance|risk score|niveau de risque)\b/i,
  /\b(legal advice|avis juridique|conseil juridique|the law requires|la loi (vous )?(oblige|exige)|you are legally|vous êtes légalement|legally entitled|légalement en droit)\b/i,
  /\b(you must accept|vous devez accepter|final and binding|définiti\w* et contraignant\w*|is binding|est contraignant\w*|ruling|jugement|verdict)\b/i,
  /\b(deadline|délai de|expires? (today|soon)|expire bientôt|last chance|dernière chance)\b/i,
];

export function agentTextProblem(value: string): string | null {
  const forbidden = scanForForbiddenContent(value);
  if (forbidden) return forbidden;
  const hit = AGENT_DENY.find((pattern) => pattern.test(value));
  return hit ? `contains a phrase the case agent may not use (${hit.source.slice(0, 40)}…)` : null;
}

export interface OutputContext {
  complainantEvidenceIds: ReadonlySet<string>;
  respondentEvidenceIds: ReadonlySet<string>;
  /** Exact extracted text from each current clean evidence object. */
  evidenceSources: ReadonlyMap<string, { text: string }>;
  amountAtStakeCents: number;
}

export type OutputCheck =
  | { ok: true; value: AgentOutput }
  | { ok: false; escalation: "model_requested_review" | "model_output_rejected"; detail: string };

export function checkAgentOutput(raw: string, ctx: OutputContext): OutputCheck {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    return { ok: false, escalation: "model_output_rejected", detail: "not JSON" };
  }
  const parsed = agentOutputSchema.safeParse(parsedJson);
  if (!parsed.success) return { ok: false, escalation: "model_output_rejected", detail: "schema" };
  const out = parsed.data;
  if (out.needs_human) return { ok: false, escalation: "model_requested_review", detail: "model asked for a person" };

  const texts = [
    ...out.summary_claims.map((claim) => claim.text),
    ...out.reasoning_claims.map((claim) => claim.text),
    ...out.limits,
    ...out.not_considered,
    ...out.citations.map((c) => c.relevance),
  ];
  for (const value of texts) {
    const problem = agentTextProblem(value);
    if (problem) return { ok: false, escalation: "model_output_rejected", detail: problem };
  }

  const all = new Set([...ctx.complainantEvidenceIds, ...ctx.respondentEvidenceIds]);
  const cited = out.citations.map((c) => c.evidence_item_id);
  const citationKeys = out.citations.map((c) => c.citation_id);
  if (new Set(cited).size !== cited.length || cited.some((id) => !all.has(id))
    || new Set(citationKeys).size !== citationKeys.length) {
    return { ok: false, escalation: "model_output_rejected", detail: "citation not in current clean case evidence" };
  }
  for (const citation of out.citations) {
    const source = ctx.evidenceSources.get(citation.evidence_item_id);
    const start = source?.text.indexOf(citation.excerpt) ?? -1;
    if (start < 0 || source?.text.lastIndexOf(citation.excerpt) !== start) {
      return { ok: false, escalation: "model_output_rejected", detail: "citation excerpt is absent or ambiguous in the current evidence extract" };
    }
  }
  const citationKeySet = new Set(citationKeys);
  const referencedCitationKeys = new Set<string>();
  for (const claim of [...out.summary_claims, ...out.reasoning_claims]) {
    if (new Set(claim.citation_ids).size !== claim.citation_ids.length
      || claim.citation_ids.some((id) => !citationKeySet.has(id))) {
      return { ok: false, escalation: "model_output_rejected", detail: "claim points to a missing or duplicate evidence citation" };
    }
    claim.citation_ids.forEach((id) => referencedCitationKeys.add(id));
  }
  if (citationKeys.some((id) => !referencedCitationKeys.has(id))) {
    return { ok: false, escalation: "model_output_rejected", detail: "evidence citation is not linked to a summary or reasoning claim" };
  }
  // Isolation: each party's outcome may point only to that party's own evidence,
  // and only to items with a verified excerpt.
  if (out.party_evidence.complainant.some((id) => !ctx.complainantEvidenceIds.has(id))
    || out.party_evidence.respondent.some((id) => !ctx.respondentEvidenceIds.has(id))) {
    return { ok: false, escalation: "model_output_rejected", detail: "outcome cites the other party's evidence" };
  }
  const citedIds = new Set(cited);
  if ([...out.party_evidence.complainant, ...out.party_evidence.respondent].some((id) => !citedIds.has(id))) {
    return { ok: false, escalation: "model_output_rejected", detail: "an outcome cites evidence without an exact excerpt" };
  }
  const problem = proposalProblem(out.proposal, ctx.amountAtStakeCents);
  if (problem) return { ok: false, escalation: "model_output_rejected", detail: problem };
  return { ok: true, value: out };
}
