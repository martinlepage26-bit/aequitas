/**
 * Phase 1 presentation rules. These are the only rules the case view and
 * the claims API use to decide what a claim is allowed to look like.
 *
 * - A claim with no claim_evidence_links row whose excerpt is non-blank
 *   after trimming renders only as NEEDS_EVIDENCE. It is not a statement
 *   Aequitas is making.
 * - An impact statement is never shown as a factual claim and is never
 *   given a fact score. Phase 1 does not score any claim.
 */

export const CLAIM_TYPES = ["FACTUAL", "CAUSAL", "MORAL", "IDENTITY", "POLICY", "IMPACT_STATEMENT"] as const;
export type ClaimTypeName = (typeof CLAIM_TYPES)[number];

export const CLAIM_CONFIDENCE = ["ESTABLISHED", "PROBABLE", "DISPUTED", "UNKNOWN"] as const;
export type ClaimConfidenceName = (typeof CLAIM_CONFIDENCE)[number];

export const CLAIM_STATUSES = ["OPEN", "NEEDS_EVIDENCE", "DISPUTED", "MERGED", "SUPERSEDED", "WITHDRAWN"] as const;
export type ClaimStatusName = (typeof CLAIM_STATUSES)[number];

export const LINK_PREDICATES = ["ORIGINATES_FROM", "SUPPORTS", "CONTRADICTS", "QUALIFIES"] as const;
export type LinkPredicateName = (typeof LINK_PREDICATES)[number];

export const RELATION_PREDICATES = [
  "SUPPORTS",
  "CONTRADICTS",
  "QUALIFIES",
  "INTERPRETS",
  "EXPERIENCED_BY",
  "OCCURRED_BEFORE",
  "ALLEGED_TO_HAVE_CONTRIBUTED_TO",
  "CONSISTENT_WITH",
  "AMPLIFIED_BY",
  "GOVERNED_BY",
  "REQUIRES_REVIEW",
  "UNRESOLVED_WITH",
  "PROPOSES_REPAIR_FOR",
  "CONTESTED_BY",
] as const;
export type RelationPredicateName = (typeof RELATION_PREDICATES)[number];

export interface ClaimRecord {
  id: string;
  claimType: ClaimTypeName;
  text: string;
  confidence: ClaimConfidenceName;
  confidenceRationale: string | null;
  status: ClaimStatusName;
  locale: string;
  createdAt: string;
  createdById: string;
  doNotSummarizeAsSettled: boolean;
}

export interface LinkRecord {
  id: string;
  claimId: string;
  sourceId: string;
  predicate: LinkPredicateName;
  excerpt: string;
  rationale: string | null;
  createdAt: string;
  createdById: string;
  deletedAt?: string | null;
}

export interface SourceRecord {
  id: string;
  title: string;
  kind: string;
  citation: string | null;
  legalFramework: string | null;
  evidenceItemId: string | null;
  evidenceTitle: string | null;
  visibility: "CASE" | "RESTRICTED" | "REDACTED";
  language: string;
  origin: string | null;
}

export interface RelationshipRecord {
  id: string;
  fromClaimId: string;
  toClaimId: string;
  predicate: RelationPredicateName;
  rationale: string | null;
  evidenceId: string | null;
}

export interface PresentedLink {
  id: string;
  sourceId: string;
  sourceTitle: string;
  sourceKind: string;
  predicate: LinkPredicateName;
  excerpt: string | null;
  redacted: boolean;
  citation: string | null;
  legalFramework: string | null;
  evidenceTitle: string | null;
  language: string;
  origin: string | null;
  createdAt: string;
  createdById: string;
  rationale: string | null;
}

export interface PresentedClaim {
  id: string;
  text: string;
  claimType: ClaimTypeName;
  /** True only when at least one verbatim excerpt link is on file. */
  rendered: boolean;
  renderedStatus: ClaimStatusName;
  displayedConfidence: ClaimConfidenceName;
  shownAsFactClaim: boolean;
  scoredAsFact: boolean;
  doNotSummarizeAsSettled: boolean;
  locale: string;
  createdAt: string;
  createdById: string;
  confidenceRationale: string | null;
  links: PresentedLink[];
}

export interface ClaimsView {
  rendered: PresentedClaim[];
  needsEvidence: PresentedClaim[];
  relationships: RelationshipRecord[];
}

/** Blank and whitespace-only excerpts do not count as verbatim. */
export function verbatimExcerpt(excerpt: string | null | undefined): string | null {
  if (typeof excerpt !== "string") return null;
  const trimmed = excerpt.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function linksWithVerbatimExcerpt<T extends { excerpt: string; deletedAt?: string | null }>(links: T[]): T[] {
  return links.filter((link) => !link.deletedAt && verbatimExcerpt(link.excerpt) !== null);
}

/**
 * Impact statements are never scored as factual claims. Phase 1 does not
 * assign a fact score to any claim type.
 */
export function scoredAsFactClaim(claim: { claimType: ClaimTypeName }): boolean {
  if (claim.claimType === "IMPACT_STATEMENT") return false;
  return false;
}

export function shownAsFactClaim(
  claim: { claimType: ClaimTypeName; status: ClaimStatusName },
  links: Array<{ excerpt: string; deletedAt?: string | null }>,
): boolean {
  if (claim.claimType !== "FACTUAL") return false;
  if (linksWithVerbatimExcerpt(links).length === 0) return false;
  return claim.status !== "NEEDS_EVIDENCE";
}

export function renderedClaimStatus(
  claim: { status: ClaimStatusName },
  links: Array<{ excerpt: string; deletedAt?: string | null }>,
): ClaimStatusName {
  if (linksWithVerbatimExcerpt(links).length === 0) return "NEEDS_EVIDENCE";
  return claim.status;
}

function restrictedFromViewer(source: SourceRecord, viewerCanSeeRestricted: boolean): boolean {
  if (viewerCanSeeRestricted) return false;
  return source.visibility === "RESTRICTED" || source.visibility === "REDACTED";
}

export function buildClaimsView(input: {
  claims: ClaimRecord[];
  links: LinkRecord[];
  sources: SourceRecord[];
  relationships: RelationshipRecord[];
  viewerCanSeeRestricted: boolean;
}): ClaimsView {
  const sourcesById = new Map(input.sources.map((source) => [source.id, source]));
  const rendered: PresentedClaim[] = [];
  const needsEvidence: PresentedClaim[] = [];

  for (const claim of input.claims) {
    const ownLinks = linksWithVerbatimExcerpt(input.links.filter((link) => link.claimId === claim.id));
    const hasExcerpt = ownLinks.length > 0;
    const renderedStatus = renderedClaimStatus(claim, ownLinks);
    const impact = claim.claimType === "IMPACT_STATEMENT";
    const presentedLinks: PresentedLink[] = hasExcerpt
      ? ownLinks.map((link) => {
          const source = sourcesById.get(link.sourceId);
          const redacted = source ? restrictedFromViewer(source, input.viewerCanSeeRestricted) : false;
          return {
            id: link.id,
            sourceId: link.sourceId,
            sourceTitle: source?.title ?? "",
            sourceKind: source?.kind ?? "",
            predicate: link.predicate,
            excerpt: redacted ? null : verbatimExcerpt(link.excerpt),
            redacted,
            citation: source?.citation ?? null,
            legalFramework: source?.legalFramework ?? null,
            evidenceTitle: source?.evidenceTitle ?? null,
            language: source?.language ?? "",
            origin: source?.origin ?? null,
            createdAt: link.createdAt,
            createdById: link.createdById,
            rationale: link.rationale,
          };
        })
      : [];

    const presented: PresentedClaim = {
      id: claim.id,
      text: claim.text,
      claimType: claim.claimType,
      rendered: hasExcerpt,
      renderedStatus,
      displayedConfidence: hasExcerpt ? claim.confidence : "UNKNOWN",
      shownAsFactClaim: shownAsFactClaim(claim, ownLinks),
      scoredAsFact: scoredAsFactClaim(claim),
      doNotSummarizeAsSettled: impact || claim.doNotSummarizeAsSettled,
      locale: claim.locale,
      createdAt: claim.createdAt,
      createdById: claim.createdById,
      confidenceRationale: claim.confidenceRationale,
      links: presentedLinks,
    };

    if (hasExcerpt) rendered.push(presented);
    else needsEvidence.push(presented);
  }

  return { rendered, needsEvidence, relationships: input.relationships };
}
