import { describe, expect, it } from "vitest";
import { claimReadPermission, claimWritePermission } from "../../src/domain/claimWrites";
import {
  buildClaimsView,
  renderedClaimStatus,
  scoredAsFactClaim,
  shownAsFactClaim,
  verbatimExcerpt,
  type ClaimRecord,
  type LinkRecord,
  type SourceRecord,
} from "../../src/domain/claimPresentation";
import { replayCaseState } from "../../src/domain/replay";

const claim = (overrides: Partial<ClaimRecord> = {}): ClaimRecord => ({
  id: "claim-1",
  claimType: "FACTUAL",
  text: "The invoice is dated 2 March.",
  confidence: "ESTABLISHED",
  confidenceRationale: null,
  status: "OPEN",
  locale: "en-CA",
  createdAt: "2026-03-02T12:00:00.000Z",
  createdById: "manager-1",
  doNotSummarizeAsSettled: false,
  ...overrides,
});

const link = (overrides: Partial<LinkRecord> = {}): LinkRecord => ({
  id: "link-1",
  claimId: "claim-1",
  sourceId: "source-1",
  predicate: "ORIGINATES_FROM",
  excerpt: "Invoice dated 2 March 2026.",
  rationale: null,
  createdAt: "2026-03-02T12:05:00.000Z",
  createdById: "manager-1",
  ...overrides,
});

const source: SourceRecord = {
  id: "source-1",
  title: "Invoice",
  kind: "DOCUMENT",
  citation: null,
  legalFramework: null,
  evidenceItemId: null,
  evidenceTitle: null,
  visibility: "CASE",
  language: "en-CA",
  origin: "Complainant",
};

describe("claim presentation invariants", () => {
  it("treats blank excerpts as missing", () => {
    expect(verbatimExcerpt("  ")).toBeNull();
    expect(verbatimExcerpt("quoted")).toBe("quoted");
  });

  it("renders a claim without a verbatim excerpt only as needs_evidence", () => {
    for (const status of ["OPEN", "DISPUTED", "MERGED", "SUPERSEDED", "WITHDRAWN"] as const) {
      expect(renderedClaimStatus(claim({ status }), [link({ excerpt: "   " })])).toBe("NEEDS_EVIDENCE");
    }
    const view = buildClaimsView({
      claims: [claim({ status: "OPEN", confidence: "ESTABLISHED" })],
      links: [link({ excerpt: " \n " })],
      sources: [source],
      relationships: [],
      viewerCanSeeRestricted: true,
    });
    expect(view.rendered).toEqual([]);
    expect(view.needsEvidence[0]).toMatchObject({
      rendered: false,
      renderedStatus: "NEEDS_EVIDENCE",
      displayedConfidence: "UNKNOWN",
      shownAsFactClaim: false,
      scoredAsFact: false,
    });
  });

  it("never shows or scores an impact statement as a fact claim", () => {
    const impact = claim({ id: "impact-1", claimType: "IMPACT_STATEMENT", confidence: "ESTABLISHED", status: "OPEN", text: "I lost sleep over the unpaid invoice." });
    expect(scoredAsFactClaim(impact)).toBe(false);
    expect(shownAsFactClaim(impact, [link({ claimId: "impact-1" })])).toBe(false);
    const view = buildClaimsView({
      claims: [impact],
      links: [link({ claimId: "impact-1", excerpt: "I have not slept since the invoice went unpaid." })],
      sources: [source],
      relationships: [],
      viewerCanSeeRestricted: true,
    });
    expect(view.rendered[0]).toMatchObject({
      claimType: "IMPACT_STATEMENT",
      shownAsFactClaim: false,
      scoredAsFact: false,
      doNotSummarizeAsSettled: true,
    });
    expect(view.rendered[0]?.claimType).not.toBe("FACTUAL");
  });

  it("keeps a supported factual claim out of the needs-evidence list", () => {
    const view = buildClaimsView({
      claims: [claim()],
      links: [link()],
      sources: [source],
      relationships: [],
      viewerCanSeeRestricted: true,
    });
    expect(view.rendered.map((item) => item.id)).toEqual(["claim-1"]);
    expect(view.rendered[0]?.links[0]?.excerpt).toBe("Invoice dated 2 March 2026.");
    expect(view.needsEvidence).toEqual([]);
  });
});

describe("claim permissions", () => {
  it("lets only the assigned case manager author claims", () => {
    expect(claimWritePermission({ access: "assigned-manager", globalRole: "CASE_MANAGER" })).toEqual({ ok: true });
  });

  it("refuses administrators, parties, and managers who have not claimed the case", () => {
    expect(claimWritePermission({ access: "admin", globalRole: "ADMIN" }).ok).toBe(false);
    expect(claimWritePermission({ access: "party", globalRole: "COMPLAINANT" }).ok).toBe(false);
    expect(claimWritePermission({ access: "party", globalRole: "RESPONDENT" }).ok).toBe(false);
    expect(claimWritePermission({ access: "claimable", globalRole: "CASE_MANAGER" }).ok).toBe(false);
    expect(claimWritePermission({ access: null, globalRole: "CASE_MANAGER" })).toMatchObject({ step: "not-found" });
  });

  it("lets parties and administrators read claims", () => {
    expect(claimReadPermission("party")).toBe(true);
    expect(claimReadPermission("admin")).toBe(true);
    expect(claimReadPermission("assigned-manager")).toBe(true);
    expect(claimReadPermission(null)).toBe(false);
  });
});

describe("traceable-core events do not move the case", () => {
  it("replays claim writes as audit-only", () => {
    expect(replayCaseState([
      { type: "CASE_CREATED" },
      { type: "CASE_SUBMITTED" },
      { type: "SOURCE_RECORDED" },
      { type: "CLAIM_RECORDED" },
      { type: "CLAIM_EVIDENCE_LINKED" },
      { type: "CLAIM_RELATIONSHIP_RECORDED" },
      { type: "REVIEW_RECORDED" },
      { type: "CLAIM_UPDATED" },
    ])).toBe("OPEN");
  });
});
