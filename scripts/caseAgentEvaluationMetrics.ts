import type { TextCompletionUsage } from "../src/domain/pipeline/provider";

export type ModelCallMetric = {
  latencyMs: number;
  promptCharacters: number;
  responseCharacters: number | null;
  tokenUsage: TextCompletionUsage | null;
};

export function characterCount(value: string): number {
  return Array.from(value).length;
}

export function tokenTotals(calls: ModelCallMetric[]) {
  const usageFields: (keyof TextCompletionUsage)[] = ["promptTokens", "completionTokens", "totalTokens"];
  const sumIfComplete = (field: keyof TextCompletionUsage) => calls.length > 0 && calls.every((call) => call.tokenUsage?.[field] !== undefined)
    ? calls.reduce((sum, call) => sum + (call.tokenUsage?.[field] ?? 0), 0)
    : null;
  return {
    reportedCalls: calls.filter((call) => call.tokenUsage !== null).length,
    callsWithoutProviderUsage: calls.filter((call) => call.tokenUsage === null).length,
    callsWithPartialUsage: calls.filter((call) => call.tokenUsage !== null
      && usageFields.some((field) => call.tokenUsage?.[field] === undefined)).length,
    promptTokens: sumIfComplete("promptTokens"),
    completionTokens: sumIfComplete("completionTokens"),
    totalTokens: sumIfComplete("totalTokens"),
    // Token counts are not billed currency and do not replace provider invoices.
    billedCurrencyCost: null,
  };
}
