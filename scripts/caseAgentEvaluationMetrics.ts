import type { TextCompletionUsage } from "../src/domain/pipeline/provider";

export type ModelCallMetric = {
  latencyMs: number;
  promptCharacters: number;
  responseCharacters: number | null;
  tokenUsage: TextCompletionUsage | null;
};

export type EvaluationPricing = {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
};

export function characterCount(value: string): number {
  return Array.from(value).length;
}

function optionValue(args: string[], option: string): string | undefined {
  const matches = args.filter((arg) => arg === option || arg.startsWith(option + "="));
  if (matches.length > 1) throw new Error("Pass " + option + " at most once.");
  if (matches.length === 0) return undefined;
  if (matches[0] === option) throw new Error(option + " needs a nonnegative USD rate.");
  return matches[0].slice(option.length + 1);
}

function parseRate(value: string, option: string): number {
  const rate = Number(value);
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) || !Number.isFinite(rate)) {
    throw new Error(option + " must be a nonnegative decimal USD price per million tokens.");
  }
  return rate;
}

/** Optional, operator-supplied rates for a transparent estimate; never queried or inferred. */
export function parseEvaluationPricing(args: string[]): EvaluationPricing | null {
  const input = optionValue(args, "--input-usd-per-million");
  const output = optionValue(args, "--output-usd-per-million");
  if (input === undefined && output === undefined) return null;
  if (input === undefined || output === undefined) {
    throw new Error("Cost estimates need both --input-usd-per-million and --output-usd-per-million.");
  }
  return {
    inputUsdPerMillion: parseRate(input, "--input-usd-per-million"),
    outputUsdPerMillion: parseRate(output, "--output-usd-per-million"),
  };
}

export function tokenTotals(calls: ModelCallMetric[], pricing: EvaluationPricing | null = null) {
  const usageFields: (keyof TextCompletionUsage)[] = ["promptTokens", "completionTokens", "totalTokens"];
  const sumIfComplete = (field: keyof TextCompletionUsage) => calls.length > 0 && calls.every((call) => call.tokenUsage?.[field] !== undefined)
    ? calls.reduce((sum, call) => sum + (call.tokenUsage?.[field] ?? 0), 0)
    : null;
  const promptTokens = sumIfComplete("promptTokens");
  const completionTokens = sumIfComplete("completionTokens");
  let estimatedProviderCostUsd: number | null = null;
  if (pricing) {
    if (calls.length === 0) estimatedProviderCostUsd = 0;
    else if (promptTokens !== null && completionTokens !== null) {
      const estimate = (promptTokens * pricing.inputUsdPerMillion
        + completionTokens * pricing.outputUsdPerMillion) / 1_000_000;
      if (Number.isFinite(estimate)) estimatedProviderCostUsd = Number(estimate.toFixed(8));
    }
  }
  return {
    reportedCalls: calls.filter((call) => call.tokenUsage !== null).length,
    callsWithoutProviderUsage: calls.filter((call) => call.tokenUsage === null).length,
    callsWithPartialUsage: calls.filter((call) => call.tokenUsage !== null
      && usageFields.some((field) => call.tokenUsage?.[field] === undefined)).length,
    promptTokens,
    completionTokens,
    totalTokens: sumIfComplete("totalTokens"),
    // An estimate is available only with complete provider usage and explicit rates.
    estimatedProviderCostUsd,
    // The provider invoice remains authoritative even when an estimate is present.
    billedCurrencyCost: null,
  };
}
