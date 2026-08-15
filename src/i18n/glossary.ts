// Single source for legally loaded terms — aequitas-implementation-handoff.md
// Section 12. UI copy, generated documents, and the forbidden-terms CI check
// all read from this file rather than restating these terms inline, so a
// wording change happens in exactly one place.

export interface GlossaryEntry {
  concept: string;
  en: string;
  fr: string;
}

export const GLOSSARY: GlossaryEntry[] = [
  { concept: "proposed outcome", en: "proposed outcome", fr: "résultat proposé" },
  { concept: "issue (a recommendation)", en: "issue", fr: "rendre (une recommandation)" },
  { concept: "consent", en: "consent", fr: "consentir / consentement" },
  { concept: "withdraw consent", en: "withdraw consent", fr: "retirer son consentement" },
  { concept: "evidence", en: "evidence", fr: "pièce / élément de preuve" },
  { concept: "neutral case manager", en: "neutral case manager", fr: "gestionnaire de dossier neutre" },
  { concept: "simulated case", en: "simulated case", fr: "dossier simulé" },
  { concept: "position", en: "position", fr: "position" },
  { concept: "reviewer", en: "reviewer", fr: "réviseur" },
];

// Terms that must never appear in user-facing strings when describing an
// AI-drafted or issued recommendation (guardrail 6: "Terminology is law").
export const FORBIDDEN_TERMS: RegExp[] = [
  /\bdecision\b/i,
  /\bdécision\b/i,
  /\bauto-approve\b/i,
  /\bscore\b/i,
];
