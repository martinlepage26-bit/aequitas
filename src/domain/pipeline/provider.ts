import { PIPELINE_OFF_REASON, pipelineEnabled } from "./flag";

/** Current Flash model with a free tier on Google AI Studio, confirmed 2026-10-09. */
export const GEMINI_FLASH_MODEL = "gemini-3.8-flash";

/** Current Workers AI evaluation candidate; review the model catalog before use. */
export const WORKERS_AI_MODEL = "@cf/google/gemma-4-26b-a4b-it";
const WORKERS_AI_STRUCTURED_OUTPUT_MAX_TOKENS = 16_000;

const PAID_PROVIDERS = new Set(["anthropic", "openai", "claude"]);

export interface TextCompletion {
  provider: string;
  model: string;
  complete(prompt: string): Promise<string>;
  /** Optional provider-native constrained output. Callers must still validate the returned JSON. */
  completeWithJsonSchema?(prompt: string, schema: Record<string, unknown>): Promise<TextCompletionWithUsage>;
  /** Optional provider-reported metering. Never estimate tokens from text. */
  completeWithUsage?(prompt: string): Promise<TextCompletionWithUsage>;
}

export interface TextCompletionUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface TextCompletionWithUsage {
  text: string;
  usage?: TextCompletionUsage;
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function usageCounts(input: unknown, output: unknown, total: unknown): TextCompletionUsage | undefined {
  const promptTokens = tokenCount(input);
  const completionTokens = tokenCount(output);
  const totalTokens = tokenCount(total);
  const usage: TextCompletionUsage = {
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    ...(completionTokens !== undefined ? { completionTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
  return Object.keys(usage).length ? usage : undefined;
}

function geminiModel(apiKey: string, model: string, fetchImpl: typeof fetch): TextCompletion {
  async function completeWithUsage(prompt: string): Promise<TextCompletionWithUsage> {
    const response = await fetchImpl(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0, responseMimeType: "application/json" },
        }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) throw new Error(`Gemini request failed (${response.status}).`);
    const body = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: { promptTokenCount?: unknown; candidatesTokenCount?: unknown; totalTokenCount?: unknown };
    };
    const text = body.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
    if (!text.trim()) throw new Error("Gemini returned an empty response.");
    return {
      text,
      usage: usageCounts(body.usageMetadata?.promptTokenCount, body.usageMetadata?.candidatesTokenCount, body.usageMetadata?.totalTokenCount),
    };
  }
  return {
    provider: "gemini",
    model,
    completeWithUsage,
    async complete(prompt: string) { return (await completeWithUsage(prompt)).text; },
  };
}

function workersModel(accountId: string, token: string, model: string, fetchImpl: typeof fetch): TextCompletion {
  async function completeWithUsage(prompt: string): Promise<TextCompletionWithUsage> {
    const response = await fetchImpl(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${model}`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ messages: [{ role: "user", content: prompt }] }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) throw new Error(`Workers AI request failed (${response.status}).`);
    const body = (await response.json()) as {
      result?: { response?: string; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown } };
      response?: string;
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown };
    };
    const text = body.result?.response ?? body.response ?? "";
    if (!text.trim()) throw new Error("Workers AI returned an empty response.");
    const usage = body.result?.usage ?? body.usage;
    return {
      text,
      usage: usageCounts(usage?.prompt_tokens, usage?.completion_tokens, usage?.total_tokens),
    };
  }

  async function completeWithJsonSchema(prompt: string, schema: Record<string, unknown>): Promise<TextCompletionWithUsage> {
    const response = await fetchImpl(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${model}`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({
          messages: [{ role: "user", content: prompt }],
          tools: [{
            name: "return_structured_output",
            description: "Return the requested result using this exact JSON object schema. Do not call any external service.",
            parameters: schema,
          }],
          tool_choice: "required",
          temperature: 0,
          max_tokens: WORKERS_AI_STRUCTURED_OUTPUT_MAX_TOKENS,
        }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) throw new Error(`Workers AI structured request failed (${response.status}).`);
    const body = (await response.json()) as {
      result?: { tool_calls?: unknown; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown } };
      tool_calls?: unknown;
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown };
    };
    const toolCalls = body.result?.tool_calls ?? body.tool_calls;
    if (!Array.isArray(toolCalls) || toolCalls.length !== 1) {
      throw new Error("Workers AI did not return exactly one structured output call.");
    }
    const call = toolCalls[0] as { name?: unknown; arguments?: unknown; function?: { name?: unknown; arguments?: unknown } };
    const name = call.name ?? call.function?.name;
    if (name !== "return_structured_output") throw new Error("Workers AI returned an unexpected structured output call.");
    let args = call.arguments ?? call.function?.arguments;
    if (typeof args === "string") {
      try { args = JSON.parse(args) as unknown; }
      catch { throw new Error("Workers AI returned invalid structured output arguments."); }
    }
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      throw new Error("Workers AI returned invalid structured output arguments.");
    }
    const usage = body.result?.usage ?? body.usage;
    return {
      text: JSON.stringify(args),
      usage: usageCounts(usage?.prompt_tokens, usage?.completion_tokens, usage?.total_tokens),
    };
  }

  return {
    provider: "workers-ai",
    model,
    completeWithJsonSchema,
    completeWithUsage,
    async complete(prompt: string) { return (await completeWithUsage(prompt)).text; },
  };
}

export function resolveFreeTextModel(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
  fetchImpl: typeof fetch = fetch,
): { ok: true; model: TextCompletion } | { ok: false; reason: string } {
  if (!pipelineEnabled(env)) return { ok: false, reason: PIPELINE_OFF_REASON };
  const provider = (env.AEQUITAS_PIPELINE_PROVIDER ?? "gemini").trim().toLowerCase();
  if (PAID_PROVIDERS.has(provider)) {
    return { ok: false, reason: "This pipeline does not call Anthropic or OpenAI. Choose an approved Gemini or Cloudflare Workers AI configuration." };
  }
  if (provider === "workers-ai" || provider === "cloudflare") {
    const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim();
    const token = env.CLOUDFLARE_API_TOKEN?.trim();
    if (!accountId || !token) {
      return {
        ok: false,
        reason: "Workers AI is not configured. Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.",
      };
    }
    const model = env.AEQUITAS_WORKERS_AI_MODEL?.trim() || WORKERS_AI_MODEL;
    if (!/^@cf\/[A-Za-z0-9._/-]+$/.test(model)) {
      return { ok: false, reason: "AEQUITAS_WORKERS_AI_MODEL must be a Cloudflare Workers AI model id." };
    }
    return { ok: true, model: workersModel(accountId, token, model, fetchImpl) };
  }
  if (provider !== "gemini") {
    return { ok: false, reason: "AEQUITAS_PIPELINE_PROVIDER must be gemini or workers-ai." };
  }
  const apiKey = env.GEMINI_API_KEY?.trim() || env.GOOGLE_AI_API_KEY?.trim();
  if (!apiKey) {
    return { ok: false, reason: "Gemini is not configured. Set GEMINI_API_KEY for the chosen Gemini API project." };
  }
  const model = env.GEMINI_MODEL?.trim() || GEMINI_FLASH_MODEL;
  if (!/^[A-Za-z0-9._-]+$/.test(model)) return { ok: false, reason: "GEMINI_MODEL must be a Gemini model id." };
  return { ok: true, model: geminiModel(apiKey, model, fetchImpl) };
}

/**
 * Model access for live case material. Provider credentials alone do not
 * establish acceptable data terms: Gemini's unpaid tier uses submitted
 * content to improve products, so require an explicit paid-project check.
 * Synthetic evaluations use resolveFreeTextModel directly and do not pass
 * case data through this gate.
 */
export function resolveCaseDataModel(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
  fetchImpl: typeof fetch = fetch,
): { ok: true; model: TextCompletion } | { ok: false; reason: string } {
  if (env.AEQUITAS_AI_PROVIDER_TERMS_REVIEWED !== "true") {
    return { ok: false, reason: "Review the selected provider and account's current data terms before processing case data; set AEQUITAS_AI_PROVIDER_TERMS_REVIEWED=true after review." };
  }
  const provider = (env.AEQUITAS_PIPELINE_PROVIDER ?? "gemini").trim().toLowerCase();
  if (provider === "gemini" && env.AEQUITAS_GEMINI_PAID_TIER_CONFIRMED !== "true") {
    return { ok: false, reason: "Gemini case processing requires confirmation that this API key belongs to an active-billing Paid Tier project; set AEQUITAS_GEMINI_PAID_TIER_CONFIRMED=true after checking it." };
  }
  return resolveFreeTextModel(env, fetchImpl);
}

export function freeModelConfigured(env?: Record<string, string | undefined>): boolean {
  return resolveCaseDataModel(env, fetch).ok;
}
