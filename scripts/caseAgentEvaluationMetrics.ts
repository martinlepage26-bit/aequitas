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

/** Owner-selected ceiling for the seven-call synthetic evaluation. */
export const CASE_AGENT_EVALUATION_SPEND_CAP_USD = 0.11;
/** Cloudflare model-page rates checked 2026-11-09 for the pinned Gemma 4 model. */
export const WORKERS_AI_EVALUATION_PRICING: EvaluationPricing = {
  inputUsdPerMillion: 0.1,
  outputUsdPerMillion: 0.3,
};

export type EvaluationSpendGuardOptions = {
  capUsd: number;
  maxCalls: number;
  /** Maximum serialized request bytes, used as a conservative input-token bound. */
  maxInputBytesPerCall: number;
  maxOutputTokensPerCall: number;
  pricing: EvaluationPricing;
};

function roundUsdUp(value: number): number {
  return Math.ceil(value * 100_000_000) / 100_000_000;
}

function worstCaseCostPerCallUsd(options: Omit<EvaluationSpendGuardOptions, "capUsd" | "maxCalls">): number {
  return (options.maxInputBytesPerCall * options.pricing.inputUsdPerMillion
    + options.maxOutputTokensPerCall * options.pricing.outputUsdPerMillion) / 1_000_000;
}

export function estimateWorstCaseEvaluationCostUsd(options: Omit<EvaluationSpendGuardOptions, "capUsd">): number {
  const { maxCalls, maxInputBytesPerCall, maxOutputTokensPerCall, pricing } = options;
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 1
    || !Number.isSafeInteger(maxInputBytesPerCall) || maxInputBytesPerCall < 1
    || !Number.isSafeInteger(maxOutputTokensPerCall) || maxOutputTokensPerCall < 1
    || !Number.isFinite(pricing.inputUsdPerMillion) || pricing.inputUsdPerMillion < 0
    || !Number.isFinite(pricing.outputUsdPerMillion) || pricing.outputUsdPerMillion < 0) {
    throw new Error("Evaluation spend bounds require positive limits and nonnegative finite rates.");
  }
  return roundUsdUp(worstCaseCostPerCallUsd({ maxInputBytesPerCall, maxOutputTokensPerCall, pricing }) * maxCalls);
}

/**
 * Counts reserved requests, including failed attempts, against a conservative
 * request-bound estimate. This is a local evaluator guard, not an account-wide
 * or provider-enforced billing limit.
 */
export class EvaluationSpendGuard {
  private reservedCalls = 0;
  private reservedUsd = 0;
  private readonly worstCaseUsdPerCall: number;
  readonly maximumCostUsd: number;

  constructor(private readonly options: EvaluationSpendGuardOptions) {
    if (!Number.isFinite(options.capUsd) || options.capUsd <= 0) {
      throw new Error("Evaluation spend cap must be a positive finite USD amount.");
    }
    this.maximumCostUsd = estimateWorstCaseEvaluationCostUsd(options);
    this.worstCaseUsdPerCall = worstCaseCostPerCallUsd(options);
    if (this.maximumCostUsd > options.capUsd) {
      throw new Error(
        `The conservative maximum request-bound cost ($${this.maximumCostUsd.toFixed(8)}) exceeds the authorized cap ($${options.capUsd.toFixed(2)}); no provider call is allowed.`,
      );
    }
  }

  reserveCall(): number {
    if (this.reservedCalls >= this.options.maxCalls) {
      throw new Error("The synthetic evaluation has reached its maximum provider-call count; no further request was sent.");
    }
    const nextReservedUsd = roundUsdUp(this.reservedUsd + this.worstCaseUsdPerCall);
    if (nextReservedUsd > this.options.capUsd) {
      throw new Error("The next provider request would exceed the authorized evaluation spend cap; no request was sent.");
    }
    this.reservedCalls += 1;
    this.reservedUsd = nextReservedUsd;
    return this.reservedUsd;
  }

  snapshot() {
    return {
      capUsd: this.options.capUsd,
      maximumCostUsd: this.maximumCostUsd,
      reservedCalls: this.reservedCalls,
      reservedCostUsd: this.reservedUsd,
    };
  }
}

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
