import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildExportPdf } from "../../src/domain/exportBundle";
import { sources, validMap } from "../fixtures/conflictKnowledge";

describe("knowledge map PDF export", () => {
  it("preserves bilingual source text and all graph layers in the rendered PDF", async () => {
    const now = new Date().toISOString();
    const party = { id: "synthetic", displayName: "Test Participant", email: "synthetic@example.com", locale: "fr-CA" as const };
    const map = validMap();
    const pdf = await buildExportPdf({
      exportedAt: now,
      case: { id: "synthetic", referenceNumber: "CORE-PDF", category: "EMPLOYMENT", disputeDescription: null, amountAtStakeCents: null, state: "CLOSED", simulated: true, createdAt: now, closedAt: now },
      parties: { complainant: party, respondent: party, caseManager: null },
      timeline: [], evidence: [], positions: [], consent: [],
      recommendations: [{ id: "draft", version: 1, status: "DRAFT", modelId: "synthetic", promptVersion: "test", issuedById: null, issuedByName: null, issuedAt: null, createdAt: now,
        explanation: { summary: "Synthetic map.", proposed_outcome: "Review.", reasoning: "Unresolved.", evidence_citations: [], limits: [], not_considered: [], conflict_knowledge: map, knowledge_sources: sources, model: { id: "synthetic", prompt_version: "test" }, reviewer: { user_id: null, issued_at: null } },
      }],
    });
    const dir = await mkdtemp(join(tmpdir(), "aequitas-export-test-"));
    try {
      const path = join(dir, "record.pdf");
      await writeFile(path, pdf);
      const { stdout } = await promisify(execFile)("pdftotext", [path, "-"], { timeout: 15000 });
      const text = stdout.replace(/\s+/g, " ");
      for (const expected of [
        "Je me suis senti humilié.", "The policy has not changed.",
        map.claims[0].revision_conditions, map.narratives[0].interpretation,
        map.contexts[0].power_and_positionality, map.experiences[0].disclosure_safeguards,
        map.relationships[0].rationale, map.triangulation.methods,
        map.synthesis.conditional_account, map.repair_paths[0].consent_and_safety,
        "position:p1", "aequitas-core-v1",
      ]) expect(text).toContain(expected);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }, 30000);
});
