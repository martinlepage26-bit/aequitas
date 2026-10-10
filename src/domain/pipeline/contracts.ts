import { z } from "zod";
import { absoluteClaimHit } from "./absoluteClaims";

const CLAIM_TYPES = {
  fact: "FACTUAL",
  factual: "FACTUAL",
  causal: "CAUSAL",
  moral: "MORAL",
  identity: "IDENTITY",
  policy: "POLICY",
  impact: "IMPACT_STATEMENT",
  impact_statement: "IMPACT_STATEMENT",
} as const;

const FACTOR_TYPES = {
  policy_vs_practice: "POLICY_VS_PRACTICE",
  interfaces_vs_dependencies: "INTERFACES_VS_DEPENDENCIES",
  authority_vs_implementation: "AUTHORITY_VS_IMPLEMENTATION",
} as const;

const DIAGNOSES = {
  adaptive: "ADAPTIVE",
  protective: "PROTECTIVE",
  evasive: "EVASIVE",
  fraudulent: "FRAUDULENT",
  no_gap_found: "NO_GAP_FOUND",
} as const;

const ORIGINS = {
  case_framing: "CASE_FRAMING",
  party_statement: "PARTY_STATEMENT",
  analyst_note: "ANALYST_NOTE",
  mid_case: "MID_CASE",
} as const;

export interface ProposedAssumption {
  text: string;
  origin: (typeof ORIGINS)[keyof typeof ORIGINS];
}

export interface ProposedClaim {
  claimType: (typeof CLAIM_TYPES)[keyof typeof CLAIM_TYPES];
  text: string;
  excerpt: string;
  sourceId: string;
}

export interface ProposedContextFactor {
  factorType: (typeof FACTOR_TYPES)[keyof typeof FACTOR_TYPES];
  description: string;
  gapMap: Record<string, unknown>;
  diagnosis: (typeof DIAGNOSES)[keyof typeof DIAGNOSES];
  evidenceId: string;
}

function jsonObject(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  return JSON.parse(fenced ? fenced[1] : trimmed);
}

function guardText(value: string, label: string): string | null {
  return absoluteClaimHit(value) ? `${label} uses an absolute claim.` : null;
}

export function parseAssumptionResponse(text: string): { ok: true; assumptions: ProposedAssumption[] } | { ok: false; reason: string } {
  let parsed: unknown;
  try {
    parsed = jsonObject(text);
  } catch {
    return { ok: false, reason: "The model output was not JSON." };
  }
  const schema = z.object({
    assumptions: z.array(z.object({
      text: z.string().trim().min(1).max(4000),
      origin: z.enum(["case_framing", "party_statement", "analyst_note", "mid_case"]),
    })).min(1).max(20),
  });
  const result = schema.safeParse(parsed);
  if (!result.success) return { ok: false, reason: "The model output did not match the assumption contract." };
  for (const assumption of result.data.assumptions) {
    const hit = guardText(assumption.text, "An assumption");
    if (hit) return { ok: false, reason: hit };
  }
  return {
    ok: true,
    assumptions: result.data.assumptions.map((assumption) => ({ text: assumption.text, origin: ORIGINS[assumption.origin] })),
  };
}

export function parseClaimResponse(text: string): { ok: true; claims: ProposedClaim[] } | { ok: false; reason: string } {
  let parsed: unknown;
  try {
    parsed = jsonObject(text);
  } catch {
    return { ok: false, reason: "The model output was not JSON." };
  }
  const schema = z.object({
    claims: z.array(z.object({
      claim_type: z.enum(["fact", "factual", "causal", "moral", "identity", "policy", "impact", "impact_statement"]),
      text: z.string().trim().min(1).max(4000),
      excerpt: z.string().trim().min(1).max(8000),
      source_id: z.string().uuid(),
    })).min(1).max(20),
  });
  const result = schema.safeParse(parsed);
  if (!result.success) return { ok: false, reason: "The model output did not match the claim contract." };
  for (const claim of result.data.claims) {
    const hit = guardText(`${claim.text}\n${claim.excerpt}`, "A proposed claim");
    if (hit) return { ok: false, reason: hit };
  }
  return {
    ok: true,
    claims: result.data.claims.map((claim) => ({
      claimType: CLAIM_TYPES[claim.claim_type],
      text: claim.text,
      excerpt: claim.excerpt,
      sourceId: claim.source_id,
    })),
  };
}

export function parseContextResponse(text: string): { ok: true; factors: ProposedContextFactor[] } | { ok: false; reason: string } {
  let parsed: unknown;
  try {
    parsed = jsonObject(text);
  } catch {
    return { ok: false, reason: "The model output was not JSON." };
  }
  const schema = z.object({
    context_factors: z.array(z.object({
      factor_type: z.enum(["policy_vs_practice", "interfaces_vs_dependencies", "authority_vs_implementation"]),
      description: z.string().trim().min(1).max(4000),
      gap_map: z.record(z.string(), z.unknown()).default({}),
      diagnosis: z.enum(["adaptive", "protective", "evasive", "fraudulent", "no_gap_found"]),
      evidence_id: z.string().uuid(),
    })).min(1).max(20),
  });
  const result = schema.safeParse(parsed);
  if (!result.success) return { ok: false, reason: "The model output did not match the context contract." };
  for (const factor of result.data.context_factors) {
    const hit = guardText(factor.description, "A context factor");
    if (hit) return { ok: false, reason: hit };
  }
  return {
    ok: true,
    factors: result.data.context_factors.map((factor) => ({
      factorType: FACTOR_TYPES[factor.factor_type],
      description: factor.description,
      gapMap: factor.gap_map,
      diagnosis: DIAGNOSES[factor.diagnosis],
      evidenceId: factor.evidence_id,
    })),
  };
}
