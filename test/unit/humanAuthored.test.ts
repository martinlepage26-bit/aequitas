import { describe, expect, it } from "vitest";
import { HUMAN_AUTHORED_MODEL_ID as ID, HUMAN_AUTHORED_PROMPT_VERSION as PV, humanAuthoredIssueCheck } from "../../src/domain/humanAuthored";

const cite = [{ evidence_item_id: "00000000-0000-4000-8000-000000000000", relevance: "r" }];

describe("humanAuthoredIssueCheck", () => {
  it("leaves model drafts alone", () => {
    expect(humanAuthoredIssueCheck({ modelId: "claude", promptVersion: "2026-09-22.1" }, { model: { id: "claude", prompt_version: "2026-09-22.1" }, evidence_citations: [] }))
      .toEqual({ humanAuthored: false, error: null });
  });
  it("accepts a consistent human draft with a citation", () => {
    expect(humanAuthoredIssueCheck({ modelId: ID, promptVersion: PV }, { model: { id: ID, prompt_version: PV }, evidence_citations: cite }))
      .toEqual({ humanAuthored: true, error: null });
  });
  it("blocks a human draft with no citation", () => {
    expect(humanAuthoredIssueCheck({ modelId: ID, promptVersion: PV }, { model: { id: ID, prompt_version: PV }, evidence_citations: [] }).error).toMatch(/cite/);
  });
  it("blocks any partial set of human markers", () => {
    for (const [row, model] of [
      [{ modelId: ID, promptVersion: "2026-09-22.1" }, { id: ID, prompt_version: PV }],
      [{ modelId: "claude", promptVersion: PV }, { id: ID, prompt_version: PV }],
      [{ modelId: ID, promptVersion: PV }, { id: "claude", prompt_version: PV }],
      [{ modelId: "claude", promptVersion: "2026-09-22.1" }, { id: "claude", prompt_version: PV }],
    ] as const) {
      const result = humanAuthoredIssueCheck(row, { model, evidence_citations: cite });
      expect(result.humanAuthored).toBe(false);
      expect(result.error).toMatch(/disagree/);
    }
  });
});
