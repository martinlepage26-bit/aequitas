import { PIPELINE_OFF_REASON, pipelineEnabled } from "./flag";

/** Current Flash model with a free tier on Google AI Studio, confirmed 2026-10-09. */
export const GEMINI_FLASH_MODEL = "gemini-3.8-flash";

/** Workers AI text model on the daily free neuron allocation. Not a paid-only model. */
export const WORKERS_AI_MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8";

const PAID_PROVIDERS = new Set(["anthropic", "openai", "claude"]);

export interface TextCompletion {
  provider: string;
  model: string;
  complete(prompt: string): Promise<string>;
}

function geminiModel(apiKey: string, model: string, fetchImpl: typeof fetch): TextCompletion {
  return {
    provider: "gemini",
    model,
    async complete(prompt: string) {
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
      };
      const text = body.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
      if (!text.trim()) throw new Error("Gemini returned an empty response.");
      return text;
    },
  };
}

function workersModel(accountId: string, token: string, model: string, fetchImpl: typeof fetch): TextCompletion {
  return {
    provider: "workers-ai",
    model,
    async complete(prompt: string) {
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
      const body = (await response.json()) as { result?: { response?: string }; response?: string };
      const text = body.result?.response ?? body.response ?? "";
      if (!text.trim()) throw new Error("Workers AI returned an empty response.");
      return text;
    },
  };
}

export function resolveFreeTextModel(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
  fetchImpl: typeof fetch = fetch,
): { ok: true; model: TextCompletion } | { ok: false; reason: string } {
  if (!pipelineEnabled(env)) return { ok: false, reason: PIPELINE_OFF_REASON };
  const provider = (env.AEQUITAS_PIPELINE_PROVIDER ?? "gemini").trim().toLowerCase();
  if (PAID_PROVIDERS.has(provider)) {
    return { ok: false, reason: "This pipeline does not call Anthropic or OpenAI. Use the Gemini free tier or Cloudflare Workers AI." };
  }
  if (provider === "workers-ai" || provider === "cloudflare") {
    const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim();
    const token = env.CLOUDFLARE_API_TOKEN?.trim();
    if (!accountId || !token) {
      return {
        ok: false,
        reason: "Workers AI is not configured. Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN. Stay inside the daily free allocation of 10,000 neurons.",
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
    return { ok: false, reason: "Gemini is not configured. Set GEMINI_API_KEY from Google AI Studio. The default model is gemini-3.8-flash on the free tier." };
  }
  const model = env.GEMINI_MODEL?.trim() || GEMINI_FLASH_MODEL;
  if (!/^[A-Za-z0-9._-]+$/.test(model)) return { ok: false, reason: "GEMINI_MODEL must be a Gemini model id." };
  return { ok: true, model: geminiModel(apiKey, model, fetchImpl) };
}

export function freeModelConfigured(env?: Record<string, string | undefined>): boolean {
  return resolveFreeTextModel(env, fetch).ok;
}
