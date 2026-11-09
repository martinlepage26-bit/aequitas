import { GoogleGenAI } from "@google/genai";
import { PIPELINE_OFF_REASON, pipelineEnabled } from "./flag";

/** Current Flash model with a free tier on Google AI Studio, confirmed 2026-10-09. */
export const GEMINI_FLASH_MODEL = "gemini-3.8-flash";

/** Current Workers AI evaluation candidate; review the model catalog before use. */
export const WORKERS_AI_MODEL = "@cf/google/gemma-4-26b-a4b-it";
/** Current Google Cloud model with documented ML processing at its Montréal regional endpoint. */
export const VERTEX_CANADA_MODEL = "gemini-3.5-flash";
export const VERTEX_CANADA_LOCATION = "northamerica-northeast1";
export const WORKERS_AI_STRUCTURED_OUTPUT_MAX_TOKENS = 16_000;
const GEMINI_STRUCTURED_OUTPUT_MAX_TOKENS = 16_000;
const VERTEX_STRUCTURED_OUTPUT_MAX_TOKENS = 16_000;

/** JSON Schema subset accepted by Gemini's structured text response format. */
const GEMINI_JSON_SCHEMA_KEYS = new Set([
  "$id", "$defs", "$ref", "$anchor", "type", "format", "title", "description",
  "enum", "items", "prefixItems", "minItems", "maxItems", "minimum", "maximum",
  "anyOf", "oneOf", "properties", "additionalProperties", "required", "propertyOrdering",
]);

const PAID_PROVIDERS = new Set(["anthropic", "openai", "claude"]);

export interface TextCompletion {
  provider: string;
  model: string;
  /** Optional system instruction is kept separate from untrusted user content. */
  complete(prompt: string, systemInstruction?: string): Promise<string>;
  /** Optional provider-native constrained output. Callers must still validate the returned JSON. */
  completeWithJsonSchema?(prompt: string, schema: Record<string, unknown>, systemInstruction?: string): Promise<TextCompletionWithUsage>;
  /** Optional provider-reported metering. Never estimate tokens from text. */
  completeWithUsage?(prompt: string, systemInstruction?: string): Promise<TextCompletionWithUsage>;
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

type VertexGenerateConfig = {
  temperature?: number;
  maxOutputTokens?: number;
  responseMimeType?: string;
  responseJsonSchema?: unknown;
  systemInstruction?: string;
  automaticContinuation?: boolean;
};

type VertexGenerateInput = { model: string; contents: string; config?: VertexGenerateConfig };

type VertexGenerateResponse = {
  text?: string;
  usageMetadata?: { promptTokenCount?: unknown; candidatesTokenCount?: unknown; totalTokenCount?: unknown };
};

export type VertexAiClient = {
  models: { generateContent(input: VertexGenerateInput): Promise<VertexGenerateResponse> };
};

export type VertexAiClientFactory = (
  options: NonNullable<ConstructorParameters<typeof GoogleGenAI>[0]>,
) => VertexAiClient;

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

/**
 * Gemini accepts only a JSON Schema subset. Unsupported constraints are still
 * enforced by the caller's local validator after generation; they are omitted
 * here so the provider does not reject or silently misinterpret the schema.
 */
function geminiStructuredSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(geminiStructuredSchema);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, nested]) => {
      if (!GEMINI_JSON_SCHEMA_KEYS.has(key)) return [];
      // These keys map arbitrary property/definition names to child schemas;
      // their names are data, not JSON Schema keywords.
      if ((key === "properties" || key === "$defs") && nested && typeof nested === "object" && !Array.isArray(nested)) {
        return [[key, Object.fromEntries(
          Object.entries(nested).map(([name, child]) => [name, geminiStructuredSchema(child)]),
        )]];
      }
      return [[key, geminiStructuredSchema(nested)]];
    }),
  );
}

function geminiModel(apiKey: string, model: string, fetchImpl: typeof fetch): TextCompletion {
  async function requestCompletion(
    prompt: string,
    systemInstruction: string | undefined,
    generationConfig: Record<string, unknown>,
  ): Promise<TextCompletionWithUsage> {
    const response = await fetchImpl(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          ...(systemInstruction ? { systemInstruction: { parts: [{ text: systemInstruction }] } } : {}),
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig,
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

  async function completeWithUsage(prompt: string, systemInstruction?: string): Promise<TextCompletionWithUsage> {
    return requestCompletion(prompt, systemInstruction, { temperature: 0, responseMimeType: "application/json" });
  }

  async function completeWithJsonSchema(
    prompt: string,
    schema: Record<string, unknown>,
    systemInstruction?: string,
  ): Promise<TextCompletionWithUsage> {
    return requestCompletion(prompt, systemInstruction, {
      temperature: 0,
      maxOutputTokens: GEMINI_STRUCTURED_OUTPUT_MAX_TOKENS,
      responseFormat: {
        text: {
          mimeType: "APPLICATION_JSON",
          schema: geminiStructuredSchema(schema),
        },
      },
    });
  }

  return {
    provider: "gemini",
    model,
    completeWithJsonSchema,
    completeWithUsage,
    async complete(prompt: string, systemInstruction?: string) { return (await completeWithUsage(prompt, systemInstruction)).text; },
  };
}

function workersModel(accountId: string, token: string, model: string, fetchImpl: typeof fetch): TextCompletion {
  const messages = (prompt: string, systemInstruction?: string) => [
    ...(systemInstruction ? [{ role: "system", content: systemInstruction }] : []),
    { role: "user", content: prompt },
  ];

  async function completeWithUsage(prompt: string, systemInstruction?: string): Promise<TextCompletionWithUsage> {
    const response = await fetchImpl(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${model}`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ messages: messages(prompt, systemInstruction) }),
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

  async function completeWithJsonSchema(prompt: string, schema: Record<string, unknown>, systemInstruction?: string): Promise<TextCompletionWithUsage> {
    // Use Chat Completions because its documented contract exposes required tool choice.
    const response = await fetchImpl(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/v1/chat/completions`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({
          model,
          messages: messages(prompt, systemInstruction),
          tools: [{ type: "function", function: {
            name: "return_structured_output",
            description: "Return the requested result using this exact JSON object schema. Do not call any external service.",
            parameters: schema,
          } }],
          tool_choice: "required",
          parallel_tool_calls: false,
          temperature: 0,
          max_completion_tokens: WORKERS_AI_STRUCTURED_OUTPUT_MAX_TOKENS,
        }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) throw new Error(`Workers AI structured request failed (${response.status}).`);
    const body = (await response.json()) as {
      choices?: Array<{ message?: { tool_calls?: unknown } }>;
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown };
    };
    const toolCalls = body.choices?.[0]?.message?.tool_calls;
    if (!Array.isArray(toolCalls) || toolCalls.length !== 1) {
      throw new Error("Workers AI did not return exactly one structured output call.");
    }
    const call = toolCalls[0] as { function?: { name?: unknown; arguments?: unknown } };
    if (call.function?.name !== "return_structured_output") {
      throw new Error("Workers AI returned an unexpected structured output call.");
    }
    let args = call.function.arguments;
    if (typeof args === "string") {
      try { args = JSON.parse(args) as unknown; }
      catch { throw new Error("Workers AI returned invalid structured output arguments."); }
    }
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      throw new Error("Workers AI returned invalid structured output arguments.");
    }
    return {
      text: JSON.stringify(args),
      usage: usageCounts(body.usage?.prompt_tokens, body.usage?.completion_tokens, body.usage?.total_tokens),
    };
  }

  return {
    provider: "workers-ai",
    model,
    completeWithJsonSchema,
    completeWithUsage,
    async complete(prompt: string, systemInstruction?: string) { return (await completeWithUsage(prompt, systemInstruction)).text; },
  };
}

function defaultVertexAiClientFactory(options: Parameters<VertexAiClientFactory>[0]): VertexAiClient {
  return new GoogleGenAI(options) as unknown as VertexAiClient;
}

function vertexAiModel(
  projectId: string,
  location: string,
  model: string,
  fetchImpl: typeof fetch,
  clientFactory: VertexAiClientFactory,
): TextCompletion {
  const client = clientFactory({
    enterprise: true,
    project: projectId,
    location,
    apiVersion: "v1",
    httpOptions: {
      timeout: 30_000,
      retryOptions: { attempts: 1 },
      fetch: fetchImpl,
    },
  });

  async function requestCompletion(
    prompt: string,
    systemInstruction: string | undefined,
    schema?: Record<string, unknown>,
  ): Promise<TextCompletionWithUsage> {
    const response = await client.models.generateContent({
      model,
      contents: prompt,
      config: {
        temperature: 0,
        maxOutputTokens: VERTEX_STRUCTURED_OUTPUT_MAX_TOKENS,
        responseMimeType: "application/json",
        automaticContinuation: false,
        ...(systemInstruction ? { systemInstruction } : {}),
        ...(schema ? { responseJsonSchema: geminiStructuredSchema(schema) } : {}),
      },
    });
    const text = response.text ?? "";
    if (!text.trim()) throw new Error("Google Cloud Vertex AI returned an empty response.");
    return {
      text,
      usage: usageCounts(
        response.usageMetadata?.promptTokenCount,
        response.usageMetadata?.candidatesTokenCount,
        response.usageMetadata?.totalTokenCount,
      ),
    };
  }

  async function completeWithJsonSchema(
    prompt: string,
    schema: Record<string, unknown>,
    systemInstruction?: string,
  ): Promise<TextCompletionWithUsage> {
    return requestCompletion(prompt, systemInstruction, schema);
  }

  async function completeWithUsage(prompt: string, systemInstruction?: string): Promise<TextCompletionWithUsage> {
    return requestCompletion(prompt, systemInstruction);
  }

  return {
    provider: "vertex-ai",
    model,
    completeWithJsonSchema,
    completeWithUsage,
    async complete(prompt: string, systemInstruction?: string) {
      return (await completeWithUsage(prompt, systemInstruction)).text;
    },
  };
}

export function resolveFreeTextModel(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
  fetchImpl: typeof fetch = fetch,
  vertexClientFactory: VertexAiClientFactory = defaultVertexAiClientFactory,
): { ok: true; model: TextCompletion } | { ok: false; reason: string } {
  if (!pipelineEnabled(env)) return { ok: false, reason: PIPELINE_OFF_REASON };
  const provider = (env.AEQUITAS_PIPELINE_PROVIDER ?? "gemini").trim().toLowerCase();
  if (PAID_PROVIDERS.has(provider)) {
    return { ok: false, reason: "This pipeline does not call Anthropic or OpenAI. Choose an approved Gemini, Vertex AI or Cloudflare Workers AI configuration." };
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
  if (provider === "vertex-ai") {
    const projectId = env.AEQUITAS_VERTEX_PROJECT_ID?.trim();
    if (!projectId) return { ok: false, reason: "Set AEQUITAS_VERTEX_PROJECT_ID for the Google Cloud project that owns the Vertex AI configuration." };
    const location = env.AEQUITAS_VERTEX_LOCATION?.trim() || VERTEX_CANADA_LOCATION;
    if (location !== VERTEX_CANADA_LOCATION) {
      return { ok: false, reason: `The reviewed Canada route requires AEQUITAS_VERTEX_LOCATION=${VERTEX_CANADA_LOCATION}.` };
    }
    const model = env.AEQUITAS_VERTEX_MODEL?.trim() || VERTEX_CANADA_MODEL;
    if (model !== VERTEX_CANADA_MODEL) {
      return { ok: false, reason: `The reviewed Montréal route currently supports only AEQUITAS_VERTEX_MODEL=${VERTEX_CANADA_MODEL}.` };
    }
    return { ok: true, model: vertexAiModel(projectId, location, model, fetchImpl, vertexClientFactory) };
  }
  if (provider !== "gemini") {
    return { ok: false, reason: "AEQUITAS_PIPELINE_PROVIDER must be gemini, vertex-ai or workers-ai." };
  }
  const apiKey = env.GEMINI_API_KEY?.trim() || env.GOOGLE_AI_API_KEY?.trim();
  if (!apiKey) {
    return { ok: false, reason: "Gemini is not configured. Set GEMINI_API_KEY for the chosen Gemini API project." };
  }
  const model = env.GEMINI_MODEL?.trim() || GEMINI_FLASH_MODEL;
  if (!/^[A-Za-z0-9._-]+$/.test(model)) return { ok: false, reason: "GEMINI_MODEL must be a Gemini model id." };
  return { ok: true, model: geminiModel(apiKey, model, fetchImpl) };
}

/** Stable non-secret identity that a provider-terms review must match. */
export function caseDataProviderApprovalIdentity(env: Record<string, string | undefined>): string | null {
  const selected = (env.AEQUITAS_PIPELINE_PROVIDER ?? "gemini").trim().toLowerCase();
  const provider = selected === "cloudflare" ? "workers-ai" : selected;
  if (provider === "gemini") {
    const projectId = env.GEMINI_PROJECT_ID?.trim();
    const model = env.GEMINI_MODEL?.trim() || GEMINI_FLASH_MODEL;
    return projectId && model ? `gemini:${projectId}:${model}` : null;
  }
  if (provider === "workers-ai") {
    const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim();
    const model = env.AEQUITAS_WORKERS_AI_MODEL?.trim() || WORKERS_AI_MODEL;
    return accountId && model ? `workers-ai:${accountId}:${model}` : null;
  }
  if (provider === "vertex-ai") {
    const projectId = env.AEQUITAS_VERTEX_PROJECT_ID?.trim();
    const location = env.AEQUITAS_VERTEX_LOCATION?.trim() || VERTEX_CANADA_LOCATION;
    const model = env.AEQUITAS_VERTEX_MODEL?.trim() || VERTEX_CANADA_MODEL;
    if (!projectId || location !== VERTEX_CANADA_LOCATION || model !== VERTEX_CANADA_MODEL) return null;
    return `vertex-ai:${projectId}:${location}:${model}`;
  }
  return null;
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
  vertexClientFactory: VertexAiClientFactory = defaultVertexAiClientFactory,
): { ok: true; model: TextCompletion } | { ok: false; reason: string } {
  const identity = caseDataProviderApprovalIdentity(env);
  if (!identity) {
    const provider = (env.AEQUITAS_PIPELINE_PROVIDER ?? "gemini").trim().toLowerCase();
    if (provider === "gemini") {
      return { ok: false, reason: "Set GEMINI_PROJECT_ID to the project that owns the configured Gemini API key before approving Gemini case-data processing." };
    }
    if (provider === "workers-ai" || provider === "cloudflare") {
      return { ok: false, reason: "Set CLOUDFLARE_ACCOUNT_ID and the selected Workers AI model before approving case-data processing." };
    }
    if (provider === "vertex-ai") {
      return { ok: false, reason: `Set AEQUITAS_VERTEX_PROJECT_ID and use ${VERTEX_CANADA_LOCATION}/${VERTEX_CANADA_MODEL} before approving Vertex AI case-data processing.` };
    }
    return { ok: false, reason: "Select Gemini, Vertex AI or Workers AI before approving case-data processing." };
  }
  const provider = (env.AEQUITAS_PIPELINE_PROVIDER ?? "gemini").trim().toLowerCase();
  if (env.AEQUITAS_AI_PROVIDER_TERMS_REVIEWED_FOR?.trim() !== identity) {
    return { ok: false, reason: "Review the current data terms for the exact provider, account/project and model; set AEQUITAS_AI_PROVIDER_TERMS_REVIEWED_FOR to their current identity after review." };
  }
  if (provider === "gemini") {
    const projectId = env.GEMINI_PROJECT_ID?.trim();
    if (env.AEQUITAS_GEMINI_PAID_TIER_CONFIRMED_FOR?.trim() !== projectId) {
      return { ok: false, reason: "Confirm the exact Gemini API-key project has active billing and Paid Tier terms; set AEQUITAS_GEMINI_PAID_TIER_CONFIRMED_FOR to that project ID after checking it." };
    }
  }
  if (provider === "vertex-ai" && env.AEQUITAS_VERTEX_DATA_HANDLING_REVIEWED_FOR?.trim() !== identity) {
    return { ok: false, reason: "Review the exact Vertex AI project's Canada processing, retention, caching and request-log settings; set AEQUITAS_VERTEX_DATA_HANDLING_REVIEWED_FOR to the provider identity after review." };
  }
  return resolveFreeTextModel(env, fetchImpl, vertexClientFactory);
}

export function freeModelConfigured(env?: Record<string, string | undefined>): boolean {
  return resolveCaseDataModel(env, fetch).ok;
}
