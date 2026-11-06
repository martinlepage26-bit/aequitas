import { describe, expect, it } from "vitest";
import { filterExplanationForParty, filterSynthesisForParty, type HiddenSubmissionIds } from "../../src/domain/submissionVisibility";

const hidden: HiddenSubmissionIds = {
  evidenceIds: new Set(["ev-other"]),
  positionIds: new Set(["pos-other"]),
  chronologyIds: new Set(["chr-other"]),
};

const explanation = {
  summary: "COMBINED-SUMMARY quotes both sides",
  proposed_outcome: "COMBINED-OUTCOME",
  reasoning: "COMBINED-REASONING",
  proposal_reasoning: "STAFF-ONLY-PROPOSAL-BASIS",
  limits: ["COMBINED-LIMIT"],
  not_considered: ["COMBINED-SKIPPED"],
  evidence_citations: [
    { evidence_item_id: "ev-own", relevance: "OWN-RELEVANCE" },
    { evidence_item_id: "ev-other", relevance: "OTHER-RELEVANCE" },
  ],
  claim_evidence: [{ section: "summary" as const, text: "OTHER-CLAIM-LINK-TEXT", citation_ids: ["C1"] }],
  knowledge_sources: [
    { id: "src-own-ev", kind: "evidence_content", record_id: "ev-own" },
    { id: "src-other-ev", kind: "evidence_content", record_id: "ev-other" },
    { id: "src-own-pos", kind: "position", record_id: "pos-own" },
    { id: "src-other-pos", kind: "position", record_id: "pos-other" },
    { id: "src-own-chr", kind: "chronology", record_id: "chr-own" },
    { id: "src-other-chr", kind: "chronology", record_id: "chr-other" },
    { id: "src-law", kind: "legal_research", record_id: "statute-1" },
  ],
  conflict_knowledge: {
    claims: [
      { id: "c-own", statement: "OWN-CLAIM from the party's evidence", citations: [{ source_id: "src-own-ev", excerpt: "OWN-EXCERPT" }] },
      { id: "c-pos", statement: "OWN-POSITION-CLAIM", citations: [{ source_id: "src-own-pos", excerpt: "OWN-POSITION-EXCERPT" }] },
      { id: "c-chr", statement: "OWN-CHRONOLOGY-CLAIM", citations: [{ source_id: "src-own-chr", excerpt: "OWN-CHRONOLOGY-EXCERPT" }] },
      { id: "c-other", statement: "OTHER-CLAIM from the reply", citations: [{ source_id: "src-other-ev", excerpt: "OTHER-EXCERPT" }] },
      { id: "c-mixed", statement: "MIXED-CLAIM cites both filings", citations: [{ source_id: "src-own-ev", excerpt: "OWN-EXCERPT" }, { source_id: "src-other-pos", excerpt: "OTHER-POSITION-WORDING" }] },
      { id: "c-law", statement: "LAW-CLAIM cites research", citations: [{ source_id: "src-law", excerpt: "STATUTE-WORDING" }] },
    ],
    contexts: [
      { id: "ctx-own", factor: "OWN-FACTOR", citations: [{ source_id: "src-own-chr" }] },
      { id: "ctx-empty", factor: "UNSOURCED-FACTOR", citations: [] },
      { id: "ctx-mixed", factor: "MIXED-FACTOR", citations: [{ source_id: "src-own-ev" }, { source_id: "src-other-ev" }] },
    ],
    narratives: [{ id: "n1", interpretation: "NARRATIVE-WORDING" }],
    experiences: [{ id: "e1", reported_impact: "EXPERIENCE-WORDING" }],
    relationships: [{ from_id: "c-own", to_id: "c-mixed" }, { from_id: "c-own", to_id: "c-pos" }],
    triangulation: { data: "TRIANGULATION-WORDING", investigators: "", theories: "", methods: "", missing_evidence: ["MISSING-WORDING"], source_groups: [] },
    synthesis: {
      supported_claim_ids: ["c-own", "c-mixed"],
      disputed_claim_ids: ["c-other"],
      unresolved_questions: ["SYNTH-QUESTION"],
      conditional_account: "SYNTH-ACCOUNT",
      revision_conditions: "SYNTH-REVISION",
    },
    repair_paths: [{ id: "r1", action: "REPAIR-WORDING" }],
  },
};

describe("filterExplanationForParty", () => {
  it("omits combined prose and any claim or context that is not solely the party's own records", () => {
    const filtered = filterExplanationForParty(explanation, hidden);
    const serialized = JSON.stringify(filtered);
    expect(filtered.summary).toBe("");
    expect(filtered.proposed_outcome).toBe("");
    expect(filtered.reasoning).toBe("");
    expect(filtered.proposal_reasoning).toBe("");
    expect(filtered.limits).toEqual([]);
    expect(filtered.not_considered).toEqual([]);
    expect(serialized).toContain("OWN-CLAIM");
    expect(serialized).toContain("OWN-EXCERPT");
    expect(serialized).toContain("OWN-POSITION-CLAIM");
    expect(serialized).toContain("OWN-CHRONOLOGY-CLAIM");
    expect(serialized).toContain("OWN-FACTOR");
    expect(serialized).not.toContain("OTHER-CLAIM");
    expect(serialized).not.toContain("OTHER-EXCERPT");
    expect(serialized).not.toContain("OTHER-RELEVANCE");
    expect(serialized).not.toContain("OTHER-CLAIM-LINK-TEXT");
    expect(filtered.claim_evidence).toEqual([]);
    expect(serialized).not.toContain("MIXED-CLAIM");
    expect(serialized).not.toContain("OTHER-POSITION-WORDING");
    expect(serialized).not.toContain("LAW-CLAIM");
    expect(serialized).not.toContain("STATUTE-WORDING");
    expect(serialized).not.toContain("MIXED-FACTOR");
    expect(serialized).not.toContain("UNSOURCED-FACTOR");
    expect(serialized).not.toContain("NARRATIVE-WORDING");
    expect(serialized).not.toContain("EXPERIENCE-WORDING");
    expect(serialized).not.toContain("TRIANGULATION-WORDING");
    expect(serialized).not.toContain("MISSING-WORDING");
    expect(serialized).not.toContain("SYNTH-QUESTION");
    expect(serialized).not.toContain("SYNTH-ACCOUNT");
    expect(serialized).not.toContain("SYNTH-REVISION");
    expect(serialized).not.toContain("REPAIR-WORDING");
    expect(serialized).not.toContain("COMBINED-SUMMARY");
    expect(filtered.conflict_knowledge?.synthesis?.supported_claim_ids).toEqual(["c-own"]);
    expect(filtered.conflict_knowledge?.relationships).toEqual([{ from_id: "c-own", to_id: "c-pos" }]);
    expect(filtered.evidence_citations).toEqual([{ evidence_item_id: "ev-own", relevance: "" }]);
    expect(filtered.knowledge_sources?.map((source) => source.id)).toEqual(["src-own-ev", "src-own-pos", "src-own-chr"]);
  });

  it("keeps the recommendation prose when every citation is the party's own submission", () => {
    const sole = {
      summary: "OWN-SUMMARY",
      proposed_outcome: "OWN-OUTCOME",
      reasoning: "OWN-REASONING",
      proposal_reasoning: "OWN-ONLY-STAFF-BASIS",
      evidence_citations: [{ evidence_item_id: "ev-own", relevance: "OWN-RELEVANCE" }],
      claim_evidence: [{ section: "reasoning" as const, text: "STAFF-ONLY-CLAIM-LINK", citation_ids: ["C1"] }],
      knowledge_sources: [{ id: "src-own-ev", kind: "evidence_metadata", record_id: "ev-own" }],
      conflict_knowledge: {
        claims: [{ id: "c-own", statement: "OWN-CLAIM", citations: [{ source_id: "src-own-ev", excerpt: "OWN-EXCERPT" }] }],
        contexts: [{ id: "ctx-own", factor: "OWN-FACTOR", citations: [{ source_id: "src-own-ev" }] }],
      },
    };
    const filtered = filterExplanationForParty(sole, hidden);
    expect(filtered.summary).toBe("OWN-SUMMARY");
    expect(filtered.proposed_outcome).toBe("OWN-OUTCOME");
    expect(filtered.reasoning).toBe("OWN-REASONING");
    expect(filtered.proposal_reasoning).toBe("");
    expect(filtered.evidence_citations).toEqual([{ evidence_item_id: "ev-own", relevance: "OWN-RELEVANCE" }]);
    expect(filtered.claim_evidence).toEqual([]);
    expect(JSON.stringify(filtered)).not.toContain("STAFF-ONLY-CLAIM-LINK");
    expect(filtered.conflict_knowledge?.claims?.map((claim) => claim.statement)).toEqual(["OWN-CLAIM"]);
  });

  it("treats a recommendation with no source list as combined and hides it from the party", () => {
    const missing = {
      summary: "MISSING-PROVENANCE-SUMMARY",
      proposed_outcome: "MISSING-OUTCOME",
      reasoning: "MISSING-REASONING",
      limits: ["MISSING-LIMIT"],
      not_considered: ["MISSING-SKIPPED"],
      evidence_citations: [{ evidence_item_id: "ev-own", relevance: "OWN-RELEVANCE cites only this party" }],
      conflict_knowledge: {
        claims: [{ id: "c-bare", statement: "UNSOURCED-CLAIM-TEXT", citations: [] }],
        narratives: [{ id: "n1", interpretation: "UNSOURCED-NARRATIVE" }],
        synthesis: {
          conditional_account: "UNSOURCED-ACCOUNT",
          unresolved_questions: ["UNSOURCED-QUESTION"],
          revision_conditions: "UNSOURCED-REVISION",
        },
      },
    };
    for (const explanation of [missing, { ...missing, knowledge_sources: [] }]) {
      const filtered = filterExplanationForParty(explanation, hidden);
      const serialized = JSON.stringify(filtered);
      expect(filtered.summary).toBe("");
      expect(filtered.proposed_outcome).toBe("");
      expect(filtered.reasoning).toBe("");
      expect(filtered.limits).toEqual([]);
      expect(filtered.not_considered).toEqual([]);
      expect(serialized).not.toContain("MISSING-PROVENANCE-SUMMARY");
      expect(serialized).not.toContain("MISSING-OUTCOME");
      expect(serialized).not.toContain("MISSING-REASONING");
      expect(serialized).not.toContain("MISSING-LIMIT");
      expect(serialized).not.toContain("OWN-RELEVANCE");
      expect(serialized).not.toContain("UNSOURCED-CLAIM-TEXT");
      expect(serialized).not.toContain("UNSOURCED-NARRATIVE");
      expect(serialized).not.toContain("UNSOURCED-ACCOUNT");
      expect(serialized).not.toContain("UNSOURCED-QUESTION");
      expect(serialized).not.toContain("UNSOURCED-REVISION");
    }
  });

  it("hides a recommendation whose only sources are legal research", () => {
    const lawOnly = {
      summary: "LAW-ONLY-SUMMARY",
      proposed_outcome: "LAW-ONLY-OUTCOME",
      reasoning: "LAW-ONLY-REASONING",
      limits: ["LAW-ONLY-LIMIT"],
      not_considered: ["LAW-ONLY-SKIPPED"],
      evidence_citations: [],
      knowledge_sources: [{ id: "src-law", kind: "legal_research", record_id: "statute-1" }],
      conflict_knowledge: {
        claims: [{ id: "c-law", statement: "LAW-ONLY-CLAIM", citations: [{ source_id: "src-law", excerpt: "STATUTE-ONLY-WORDING" }] }],
        contexts: [{ id: "ctx-law", factor: "LAW-ONLY-FACTOR", citations: [{ source_id: "src-law" }] }],
        narratives: [{ id: "n1", interpretation: "LAW-ONLY-NARRATIVE" }],
        synthesis: { conditional_account: "LAW-ONLY-ACCOUNT", unresolved_questions: ["LAW-ONLY-QUESTION"], revision_conditions: "" },
      },
    };
    const filtered = filterExplanationForParty(lawOnly, hidden);
    const serialized = JSON.stringify(filtered);
    expect(filtered.summary).toBe("");
    expect(filtered.proposed_outcome).toBe("");
    expect(filtered.reasoning).toBe("");
    expect(serialized).not.toContain("LAW-ONLY-SUMMARY");
    expect(serialized).not.toContain("LAW-ONLY-CLAIM");
    expect(serialized).not.toContain("STATUTE-ONLY-WORDING");
    expect(serialized).not.toContain("LAW-ONLY-FACTOR");
    expect(serialized).not.toContain("LAW-ONLY-NARRATIVE");
    expect(serialized).not.toContain("LAW-ONLY-ACCOUNT");
    expect(filtered.knowledge_sources).toEqual([]);
  });
});

describe("filterSynthesisForParty", () => {
  it("keeps a sentence only when every mapped source is the party's own", () => {
    const sections = {
      established: [
        { id: "s-own", text: "SYN-OWN" },
        { id: "s-other", text: "SYN-OTHER" },
        { id: "s-mixed", text: "SYN-MIXED" },
        { id: "s-unmap", text: "SYN-UNMAP" },
      ],
      disputed: [],
    };
    const filtered = filterSynthesisForParty(sections, [
      { sentenceId: "s-own", sourceIds: ["src-own"] },
      { sentenceId: "s-other", sourceIds: ["src-other"] },
      { sentenceId: "s-mixed", sourceIds: ["src-own", "src-other"] },
    ], new Set(["src-own"]));
    expect(filtered.established.map((sentence) => sentence.text)).toEqual(["SYN-OWN"]);
    expect(filtered.disputed).toEqual([]);
  });
});
