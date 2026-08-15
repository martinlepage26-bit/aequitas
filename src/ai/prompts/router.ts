import type { DisputeCategory } from "../../generated/prisma";
import { CATEGORY_ROLE_TERMS } from "../../i18n/categoryGlossary";

/**
 * Handoff 2026-08-15-070312 "Immediate Next Steps" #2: route AI drafting
 * instructions by Case.category, so the model frames its proposed outcome
 * in the dispute's actual domain (a tenancy dispute is not a "consumer
 * dispute") and addresses each party by the domain-appropriate term instead
 * of the internal "complainant"/"respondent" labels. This is instruction
 * framing only — the hard constraints and output schema in
 * buildDraftSystemPrompt are category-invariant and stay put.
 */

export interface CategoryPromptContext {
  category: DisputeCategory;
  domainLabel: string;
  complainantTerm: string;
  respondentTerm: string;
}

const DOMAIN_LABELS: Record<DisputeCategory, string> = {
  RETAIL: "consumer dispute",
  TENANCY: "residential tenancy dispute",
  EMPLOYMENT: "employment dispute",
  B2B: "business-to-business dispute",
  FREELANCE: "freelance engagement dispute",
  P2P_MARKETPLACE: "peer-to-peer marketplace dispute",
  PARTNERSHIP: "business partnership dispute",
};

export function routePromptContext(category: DisputeCategory): CategoryPromptContext {
  const terms = CATEGORY_ROLE_TERMS[category];
  return {
    category,
    domainLabel: DOMAIN_LABELS[category],
    complainantTerm: terms.complainant.en,
    respondentTerm: terms.respondent.en,
  };
}
