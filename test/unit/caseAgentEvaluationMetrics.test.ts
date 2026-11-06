import { describe, expect, it } from "vitest";
import { characterCount, parseEvaluationPricing, tokenTotals } from "../../scripts/caseAgentEvaluationMetrics";

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
      estimatedProviderCostUsd: null,
      billedCurrencyCost: null,
    });
  });

  it("estimates cost from complete provider counts and explicit input/output rates", () => {
    const calls = [
      { latencyMs: 10, promptCharacters: 12, responseCharacters: 4, tokenUsage: { promptTokens: 11, completionTokens: 3, totalTokens: 14 } },
      { latencyMs: 20, promptCharacters: 15, responseCharacters: 6, tokenUsage: { promptTokens: 17, completionTokens: 5, totalTokens: 22 } },
    ];
    const pricing = parseEvaluationPricing([
      "--input-usd-per-million=0.10",
      "--output-usd-per-million=0.30",
    ]);
    expect(pricing).toEqual({ inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.3 });
    expect(tokenTotals(calls, pricing)).toMatchObject({ estimatedProviderCostUsd: 0.0000052, billedCurrencyCost: null });
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
      estimatedProviderCostUsd: null,
      billedCurrencyCost: null,
    });
    expect(tokenTotals([
      { latencyMs: 10, promptCharacters: 12, responseCharacters: 4, tokenUsage: { promptTokens: 11 } },
      { latencyMs: 20, promptCharacters: 15, responseCharacters: 6, tokenUsage: null },
    ], { inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.3 }).estimatedProviderCostUsd).toBeNull();
  });

  it("refuses incomplete, duplicate, and nonnumeric price input", () => {
    expect(() => parseEvaluationPricing(["--input-usd-per-million=0.1"])).toThrow("need both");
    expect(() => parseEvaluationPricing([
      "--input-usd-per-million=0.1", "--input-usd-per-million=0.2", "--output-usd-per-million=0.3",
    ])).toThrow("at most once");
    expect(() => parseEvaluationPricing([
      "--input-usd-per-million=-0.1", "--output-usd-per-million=0.3",
    ])).toThrow("nonnegative decimal");
  });

  it("reports zero for fixtures that make no model calls", () => {
    expect(tokenTotals([], { inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.3 }).estimatedProviderCostUsd).toBe(0);
  });
});
