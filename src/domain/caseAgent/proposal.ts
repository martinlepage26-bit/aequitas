import { z } from "zod";

/**
 * What a party actually reads. The model chooses a remedy from a closed list
 * and, where needed, an amount; this file turns that into fixed French or
 * English text. No model-written sentence reaches a party, so a party
 * outcome cannot carry the other party's words or private details.
 *
 * The remedy list is product scope for retail disputes and must be
 * confirmed by the program (see docs/case-agent-prototype.md).
 */
export const REMEDIES = ["refund_full", "refund_partial", "store_credit", "replacement", "repair"] as const;
export type Remedy = (typeof REMEDIES)[number];

/** Parse an explicit program remedy subset and return it in canonical product order. */
export function parseAllowedRemedies(value: string | undefined): Remedy[] | null {
  if (value === undefined || value.trim() === "") return null;
  const supplied = value.split(",").map((item) => item.trim());
  if (supplied.some((item) => !item) || new Set(supplied).size !== supplied.length
    || supplied.some((item) => !(REMEDIES as readonly string[]).includes(item))) return null;
  const selected = new Set(supplied as Remedy[]);
  const canonical = REMEDIES.filter((remedy) => selected.has(remedy));
  return canonical.length > 0 ? [...canonical] : null;
}

export const proposalSchema = z.object({
  remedy: z.enum(REMEDIES),
  amount_cents: z.number().int().positive().nullable(),
}).strict();
export type Proposal = z.infer<typeof proposalSchema>;

/** Deterministic checks against the case: amounts are needed only where they apply and never exceed the amount at stake. */
export function proposalProblem(p: Proposal, amountAtStakeCents: number): string | null {
  const needsAmount = p.remedy === "refund_partial" || p.remedy === "store_credit";
  if (needsAmount && p.amount_cents === null) return "this remedy needs an amount";
  if (!needsAmount && p.amount_cents !== null) return "this remedy takes no amount";
  if (p.amount_cents !== null && p.amount_cents > amountAtStakeCents) return "amount exceeds the amount at stake";
  if (p.remedy === "refund_partial" && p.amount_cents === amountAtStakeCents) return "a partial refund cannot equal the full amount";
  return null;
}

const money = (cents: number, locale: string) =>
  new Intl.NumberFormat(locale, { style: "currency", currency: "CAD" }).format(cents / 100);

const ACTION: Record<Remedy, { fr: (a: string) => string; en: (a: string) => string }> = {
  refund_full: { fr: (a) => `le commerçant rembourse le prix payé (${a})`, en: (a) => `the business refunds the price paid (${a})` },
  refund_partial: { fr: (a) => `le commerçant rembourse ${a}`, en: (a) => `the business refunds ${a}` },
  store_credit: { fr: (a) => `le commerçant accorde un crédit en magasin de ${a}`, en: (a) => `the business gives store credit of ${a}` },
  replacement: { fr: () => "le commerçant remplace l’article", en: () => "the business replaces the item" },
  repair: { fr: () => "le commerçant fait réparer l’article sans frais", en: () => "the business has the item repaired at no charge" },
};

/** The same proposal, worded for each party in that party's language. */
export function renderProposal(p: Proposal, amountAtStakeCents: number, role: "complainant" | "respondent", locale: string): string {
  const fr = locale === "fr-CA";
  const amount = money(p.remedy === "refund_full" ? amountAtStakeCents : p.amount_cents ?? 0, fr ? "fr-CA" : "en-CA");
  const action = ACTION[p.remedy][fr ? "fr" : "en"](amount);
  const lead = fr
    ? role === "complainant" ? "Proposition pour régler votre demande : " : "Proposition pour régler la demande présentée contre votre entreprise : "
    : role === "complainant" ? "Proposal to settle your claim: " : "Proposal to settle the claim made against your business: ";
  const tail = fr
    ? " Cette proposition n’est pas contraignante et ne constitue pas un avis juridique. Elle ne prend effet que si les deux parties y consentent. Vous pouvez consentir, refuser ou demander qu’une personne examine le dossier."
    : " This proposal is not binding and is not legal advice. It takes effect only if both parties consent. You may consent, decline, or ask for a person to review the case.";
  return `${lead}${action}.${tail}`;
}
