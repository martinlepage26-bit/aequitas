import { describe, expect, it } from "vitest";
import { characterCount, tokenTotals } from "../../scripts/caseAgentEvaluationMetrics";

describe("case-agent evaluation metrics", () => {
  it("counts Unicode code points rather than UTF-16 units", () => {
    expect(characterCount("é🧭")).toBe(2);
  });

  it("sums provider-reported token counts only when each field is complete", () => {
    const totals = tokenTotals([
      { latencyMs: 10, promptCharacters: 12, responseCharacters: 4, tokenUsage: { promptTokens: 11, completionTokens: 3, totalTokens: 14 } },
      { latencyMs: 20, promptCharacters: 15, responseCharacters: 6, tokenUsage: { promptTokens: 17, completionTokens: 5, totalTokens: 22 } },
    ]);
    expect(totals).toEqual({
      reportedCalls: 2,
      callsWithoutProviderUsage: 0,
      callsWithPartialUsage: 0,
      promptTokens: 28,
      completionTokens: 8,
      totalTokens: 36,
      billedCurrencyCost: null,
    });
  });

  it("does not turn missing or partial provider usage into zero", () => {
    const totals = tokenTotals([
      { latencyMs: 10, promptCharacters: 12, responseCharacters: 4, tokenUsage: { promptTokens: 11 } },
      { latencyMs: 20, promptCharacters: 15, responseCharacters: 6, tokenUsage: null },
    ]);
    expect(totals).toEqual({
      reportedCalls: 1,
      callsWithoutProviderUsage: 1,
      callsWithPartialUsage: 1,
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      billedCurrencyCost: null,
    });
  });
});
