import type { DisputeCategory } from "../generated/prisma";

// Handoff 2026-08-15-070312 "Immediate Next Steps" #3: the UI must show
// domain-appropriate party labels ("Tenant" / "Landlord") instead of the
// literal internal role names ("Complainant" / "Respondent") based on
// Case.category. This is a plain lookup table, not a next-intl catalog —
// same pattern as src/i18n/glossary.ts's GLOSSARY, which already sits
// outside the JSON message catalogs for the same reason: these are single
// noun substitutions, not sentences needing ICU pluralization/interpolation,
// so a flat table is simpler to review than 7 categories x 2 roles x 2
// locales of catalog nesting. check-i18n-parity.mjs and
// check-forbidden-terms.mjs both scan messages/*.json only, so this file is
// outside their scope by construction, same as glossary.ts.

export interface RoleTerm {
  en: string;
  fr: string;
}

export interface CategoryRoleTerms {
  complainant: RoleTerm;
  respondent: RoleTerm;
}

export const CATEGORY_ROLE_TERMS: Record<DisputeCategory, CategoryRoleTerms> = {
  RETAIL: {
    complainant: { en: "consumer", fr: "consommateur ou consommatrice" },
    respondent: { en: "retailer", fr: "détaillant" },
  },
  TENANCY: {
    complainant: { en: "tenant", fr: "locataire" },
    respondent: { en: "landlord", fr: "propriétaire" },
  },
  EMPLOYMENT: {
    complainant: { en: "employee", fr: "employé ou employée" },
    respondent: { en: "employer", fr: "employeur" },
  },
  B2B: {
    complainant: { en: "business", fr: "entreprise" },
    respondent: { en: "counterparty", fr: "partie contractante" },
  },
  FREELANCE: {
    complainant: { en: "freelancer", fr: "pigiste" },
    respondent: { en: "client", fr: "client ou cliente" },
  },
  P2P_MARKETPLACE: {
    complainant: { en: "buyer", fr: "acheteur ou acheteuse" },
    respondent: { en: "seller", fr: "vendeur ou vendeuse" },
  },
  PARTNERSHIP: {
    complainant: { en: "partner", fr: "associé ou associée" },
    respondent: { en: "co-founder", fr: "cofondateur ou cofondatrice" },
  },
};

export const DISPUTE_CATEGORIES = Object.keys(CATEGORY_ROLE_TERMS) as DisputeCategory[];

/**
 * Resolves the domain-appropriate display term for a party role, given the
 * case's category and the viewer's locale. `locale` is matched by prefix
 * ("fr-CA" -> fr, "en-CA" -> en) since every locale this app supports is
 * one of those two families (Section 12).
 */
export function resolveRoleTerm(category: DisputeCategory, role: "complainant" | "respondent", locale: string): string {
  const term = CATEGORY_ROLE_TERMS[category][role];
  return locale.startsWith("fr") ? term.fr : term.en;
}
