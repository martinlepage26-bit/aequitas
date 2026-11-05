import { z } from "zod";
import { scanForForbiddenContent } from "../explanationRecord";

/**
 * Deterministic checks on what the model returns. The model is untrusted:
 * nothing it writes reaches a party unless every check here passes, and a
 * failed check hands the case to a person instead of retrying silently.
 *
 * These checks are conservative heuristics. They cannot prove that free
 * text is neutral, accurate, or free of the other party's information; they
 * reject the patterns the program has ruled out.
 */

export const AGENT_PROMPT_VERSION = "case-agent-2026-11-05.1";

const text = (max: number) => z.string().trim().min(1).max(max);
const ids = z.array(z.string().uuid()).max(50);

export const agentOutputSchema = z.object({
  needs_human: z.string().trim().max(500).nullable(),
  summary: text(1500),
  reasoning: text(4000),
  limits: z.array(text(500)).min(1).max(10),
  not_considered: z.array(text(500)).min(1).max(10),
  citations: z.array(z.object({ evidence_item_id: z.string().uuid(), relevance: text(500) }).strict()).min(1).max(50),
  outcomes: z.object({
    complainant: z.object({ text: text(4000), evidence_item_ids: ids.min(1) }).strict(),
    respondent: z.object({ text: text(4000), evidence_item_ids: ids.min(1) }).strict(),
  }).strict(),
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

const SHINGLE = 6;

function words(value: string): string[] {
  return value.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").match(/[\p{L}\p{N}]+/gu) ?? [];
}

function shingles(value: string): Set<string> {
  const w = words(value);
  const out = new Set<string>();
  for (let i = 0; i + SHINGLE <= w.length; i += 1) out.add(w.slice(i, i + SHINGLE).join(" "));
  return out;
}

/** True when `candidate` repeats any run of six words from `source`. */
export function sharesPassage(candidate: string, source: string): boolean {
  const theirs = shingles(source);
  if (theirs.size === 0) return false;
  for (const s of shingles(candidate)) if (theirs.has(s)) return true;
  return false;
}

export interface OutputContext {
  complainantEvidenceIds: ReadonlySet<string>;
  respondentEvidenceIds: ReadonlySet<string>;
  /** Everything the complainant submitted (position, evidence titles and descriptions, chronology). */
  complainantCorpus: string;
  respondentCorpus: string;
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

  const texts = [out.summary, out.reasoning, ...out.limits, ...out.not_considered, ...out.citations.map((c) => c.relevance), out.outcomes.complainant.text, out.outcomes.respondent.text];
  for (const value of texts) {
    const problem = agentTextProblem(value);
    if (problem) return { ok: false, escalation: "model_output_rejected", detail: problem };
  }

  const all = new Set([...ctx.complainantEvidenceIds, ...ctx.respondentEvidenceIds]);
  const cited = out.citations.map((c) => c.evidence_item_id);
  if (new Set(cited).size !== cited.length || cited.some((id) => !all.has(id))) {
    return { ok: false, escalation: "model_output_rejected", detail: "citation not in current clean case evidence" };
  }
  // Isolation: each party's outcome may rest only on that party's own evidence
  // and must not repeat the other party's words.
  if (out.outcomes.complainant.evidence_item_ids.some((id) => !ctx.complainantEvidenceIds.has(id))
    || out.outcomes.respondent.evidence_item_ids.some((id) => !ctx.respondentEvidenceIds.has(id))) {
    return { ok: false, escalation: "model_output_rejected", detail: "outcome cites the other party's evidence" };
  }
  if (sharesPassage(out.outcomes.complainant.text, ctx.respondentCorpus) || sharesPassage(out.outcomes.respondent.text, ctx.complainantCorpus)) {
    return { ok: false, escalation: "model_output_rejected", detail: "outcome repeats the other party's submission" };
  }
  return { ok: true, value: out };
}
