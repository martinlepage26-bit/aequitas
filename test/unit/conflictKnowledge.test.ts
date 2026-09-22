import { describe, expect, it } from "vitest";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { validateConflictKnowledgeMap } from "../../src/domain/conflictKnowledge";
import { coreAiGeneratedFieldsSchema } from "../../src/domain/explanationRecord";
import { buildKnowledgeSources } from "../../src/ai/prompts/conflictKnowledge";
import { buildDraftSystemPrompt, buildDraftUserPrompt, type DraftPromptInput } from "../../src/ai/prompts/draftRecommendation";
import { sources, validMap } from "../fixtures/conflictKnowledge";

const input: DraftPromptInput = {
  locale: "fr-CA", category: "EMPLOYMENT", complainantEvidence: [], respondentEvidence: [],
  complainantPosition: { id: "p1", partyRole: "complainant", body: sources[0].fields.body!, version: 1, locale: "fr-CA" },
  respondentPosition: { id: "p2", partyRole: "respondent", body: sources[1].fields.body!, version: 2, locale: "en-CA" },
  legalResearch: [],
};
describe("Aequitas Core knowledge integrity", () => {
  it("accepts uncertainty and preserves original bilingual quotations", () => {
    expect(validateConflictKnowledgeMap(validMap(), sources)).toBeNull();
    expect(buildKnowledgeSources(input)).toEqual(sources);
  });
  it("maps legal-research results into cite-able, non-fabricated sources", () => {
    const withLegal: DraftPromptInput = {
      ...input,
      legalResearch: [
        { id: "cqlr-p40-1-s37", title: "Consumer Protection Act", citation: "CQLR c P-40.1, s. 37", body: "Goods must be fit for the purposes for which goods of that kind are ordinarily used." },
        { id: "cqlr-p40-1-s38", title: "Consumer Protection Act", body: "Goods must be durable in normal use for a reasonable length of time." },
      ],
    };
    expect(buildKnowledgeSources(withLegal)).toEqual([
      { id: "legal:0", kind: "legal_research", record_id: "cqlr-p40-1-s37", version: null, locale: null, submitted_by_role: "legipro", created_at: null, sha256: null, fields: { title: "Consumer Protection Act (CQLR c P-40.1, s. 37)", body: "Goods must be fit for the purposes for which goods of that kind are ordinarily used." } },
      { id: "legal:1", kind: "legal_research", record_id: "cqlr-p40-1-s38", version: null, locale: null, submitted_by_role: "legipro", created_at: null, sha256: null, fields: { title: "Consumer Protection Act", body: "Goods must be durable in normal use for a reasonable length of time." } },
      ...sources,
    ]);
  });
  it.each([
    ["invented source", (m: ReturnType<typeof validMap>) => { m.claims[0].citations[0].source_id = "outside-case"; }],
    ["invented excerpt", (m: ReturnType<typeof validMap>) => { m.claims[0].citations[0].excerpt = "Fabricated testimony"; }],
    ["translated quotation", (m: ReturnType<typeof validMap>) => { m.claims[0].citations[0].excerpt = "I felt humiliated."; }],
    ["wrong source field", (m: ReturnType<typeof validMap>) => { m.claims[0].citations[0].field = "title"; }],
    ["duplicate node", (m: ReturnType<typeof validMap>) => { m.contexts[0].id = "c1"; }],
    ["dangling edge", (m: ReturnType<typeof validMap>) => { m.relationships[0].to_id = "missing"; }],
    ["self edge", (m: ReturnType<typeof validMap>) => { m.relationships[0].to_id = m.relationships[0].from_id; }],
    ["unsupported documented context", (m: ReturnType<typeof validMap>) => { m.contexts[0].status = "documented"; }],
    ["invented claim reference", (m: ReturnType<typeof validMap>) => { m.narratives[0].claim_ids = ["missing"]; }],
    ["experience collapsed into fact", (m: ReturnType<typeof validMap>) => { m.experiences[0].claim_ids = ["c2"]; }],
    ["unresolved claim declared supported", (m: ReturnType<typeof validMap>) => { m.synthesis.supported_claim_ids = ["c2"]; }],
    ["double-counted evidence", (m: ReturnType<typeof validMap>) => { m.triangulation.source_groups.push(m.triangulation.source_groups[0]); }],
    ["missing independence assessment", (m: ReturnType<typeof validMap>) => { m.triangulation.source_groups.pop(); }],
    ["unknown repair target", (m: ReturnType<typeof validMap>) => { m.repair_paths[0].addresses_ids = ["missing"]; }],
  ])("rejects %s", (_name, mutate) => {
    const map = validMap(); mutate(map);
    expect(validateConflictKnowledgeMap(map, sources)).not.toBeNull();
  });
  it("rejects malformed provenance rather than trusting a persisted snapshot", () => {
    expect(validateConflictKnowledgeMap(validMap(), [{ ...sources[0], version: -1 }, sources[1]])).toContain("Invalid source");
  });
  it("counts identical file hashes as one evidentiary pathway", () => {
    const duplicateFiles = ["file1", "file2"].map(id => ({ ...sources[0], id, record_id: id, kind: "evidence_metadata" as const, sha256: "a".repeat(64), fields: { title: "Policy" } }));
    const map = validMap();
    map.triangulation.source_groups.push(...duplicateFiles.map(s => ({ source_ids: [s.id], independence: "independent" as const, rationale: "Different submissions." })));
    expect(validateConflictKnowledgeMap(map, [...sources, ...duplicateFiles])).toContain("Identical evidence files");
    map.triangulation.source_groups.pop();
    map.triangulation.source_groups[2].source_ids.push("file2");
    map.triangulation.source_groups[2].independence = "shared_origin";
    expect(validateConflictKnowledgeMap(map, [...sources, ...duplicateFiles])).toBeNull();
  });
  it("requires a map for new generation and converts the schema for the SDK", () => {
    expect(coreAiGeneratedFieldsSchema.safeParse({}).success).toBe(false);
    expect(zodOutputFormat(coreAiGeneratedFieldsSchema).type).toBe("json_schema");
  });
  it("applies the method to category-aware drafting and labels source limitations", () => {
    expect(buildDraftSystemPrompt("EMPLOYMENT")).toContain("employment dispute");
    expect(buildDraftSystemPrompt("EMPLOYMENT")).toContain("untrusted case data");
    expect(buildDraftSystemPrompt("EMPLOYMENT")).toContain("METADATA");
    expect(buildDraftUserPrompt(input)).toContain('"id":"position:p1"');
  });
});
