import { describe, expect, it } from "vitest";
import { GEMINI_FLASH_MODEL, WORKERS_AI_MODEL, resolveCaseDataModel, resolveFreeTextModel } from "../../src/domain/pipeline/provider";
import { pipelineEnabled } from "../../src/domain/pipeline/flag";

describe("free pipeline provider", () => {
  it("defaults to the configured Gemini Flash and Workers AI model IDs", () => {
    expect(GEMINI_FLASH_MODEL).toBe("gemini-3.8-flash");
    expect(WORKERS_AI_MODEL).toBe("@cf/google/gemma-4-26b-a4b-it");
  });

  it("stays off unless the flag is exactly true", () => {
    expect(pipelineEnabled({})).toBe(false);
    expect(pipelineEnabled({ AEQUITAS_PIPELINE_ENABLED: "false" })).toBe(false);
    expect(pipelineEnabled({ AEQUITAS_PIPELINE_ENABLED: "true" })).toBe(true);
  });

  it("does not call the network for a refused provider or a missing API key", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response("nope", { status: 500 });
    }) as typeof fetch;
    const enabled = { AEQUITAS_PIPELINE_ENABLED: "true" };
    expect(resolveFreeTextModel({ ...enabled, AEQUITAS_PIPELINE_PROVIDER: "anthropic" }, fetchImpl).ok).toBe(false);
    expect(resolveFreeTextModel({ ...enabled, AEQUITAS_PIPELINE_PROVIDER: "openai" }, fetchImpl).ok).toBe(false);
    expect(resolveFreeTextModel(enabled, fetchImpl).ok).toBe(false);
    expect(resolveFreeTextModel({ AEQUITAS_PIPELINE_ENABLED: "false", GEMINI_API_KEY: "free-key" }, fetchImpl).ok).toBe(false);
    const workers = resolveFreeTextModel({
      ...enabled,
      AEQUITAS_PIPELINE_PROVIDER: "workers-ai",
      CLOUDFLARE_ACCOUNT_ID: "account",
      CLOUDFLARE_API_TOKEN: "token",
    }, fetchImpl);
    expect(workers.ok).toBe(true);
    if (workers.ok) expect(workers.model.model).toBe(WORKERS_AI_MODEL);
    expect(calls).toBe(0);
  });

  it("fails closed for case data until provider terms and Gemini's paid tier are confirmed", () => {
    const env = {
      AEQUITAS_PIPELINE_ENABLED: "true",
      GEMINI_API_KEY: "synthetic-test-only",
    };
    expect(resolveCaseDataModel(env).ok).toBe(false);
    expect(resolveCaseDataModel({ ...env, AEQUITAS_AI_PROVIDER_TERMS_REVIEWED: "true" }).ok).toBe(false);
    expect(resolveCaseDataModel({
      ...env,
      AEQUITAS_AI_PROVIDER_TERMS_REVIEWED: "true",
      AEQUITAS_GEMINI_PAID_TIER_CONFIRMED: "true",
    }).ok).toBe(true);
    expect(resolveCaseDataModel({
      AEQUITAS_PIPELINE_ENABLED: "true",
      AEQUITAS_PIPELINE_PROVIDER: "workers-ai",
      AEQUITAS_AI_PROVIDER_TERMS_REVIEWED: "true",
      CLOUDFLARE_ACCOUNT_ID: "account",
      CLOUDFLARE_API_TOKEN: "token",
    }).ok).toBe(true);
  });

  it("returns only provider-reported token counts for Gemini and Workers AI", async () => {
    const geminiFetch = (async () => new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: "{}" }] } }],
      usageMetadata: { promptTokenCount: 21, candidatesTokenCount: 8, totalTokenCount: 29 },
    }), { status: 200 })) as typeof fetch;
    const gemini = resolveFreeTextModel({ AEQUITAS_PIPELINE_ENABLED: "true", GEMINI_API_KEY: "test-only" }, geminiFetch);
    expect(gemini.ok).toBe(true);
    if (gemini.ok) {
      await expect(gemini.model.completeWithUsage?.("synthetic prompt")).resolves.toEqual({
        text: "{}",
        usage: { promptTokens: 21, completionTokens: 8, totalTokens: 29 },
      });
    }

    const workersFetch = (async () => new Response(JSON.stringify({
      result: { response: "{}", usage: { prompt_tokens: 34, completion_tokens: 13, total_tokens: 47 } },
    }), { status: 200 })) as typeof fetch;
    const workers = resolveFreeTextModel({
      AEQUITAS_PIPELINE_ENABLED: "true",
      AEQUITAS_PIPELINE_PROVIDER: "workers-ai",
      CLOUDFLARE_ACCOUNT_ID: "account",
      CLOUDFLARE_API_TOKEN: "test-only",
    }, workersFetch);
    expect(workers.ok).toBe(true);
    if (workers.ok) {
      await expect(workers.model.completeWithUsage?.("synthetic prompt")).resolves.toEqual({
        text: "{}",
        usage: { promptTokens: 34, completionTokens: 13, totalTokens: 47 },
      });
    }
  });

  it("requests one schema-bound tool call for Workers AI structured completions", async () => {
    let requestUrl = "";
    let requestBody: Record<string, unknown> | undefined;
    const workersFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestUrl = String(input);
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ result: {
        tool_calls: [{ name: "return_structured_output", arguments: { value: "synthetic result" } }],
        usage: { prompt_tokens: 29, completion_tokens: 11, total_tokens: 40 },
      } }), { status: 200 });
    }) as typeof fetch;
    const workers = resolveFreeTextModel({
      AEQUITAS_PIPELINE_ENABLED: "true",
      AEQUITAS_PIPELINE_PROVIDER: "workers-ai",
      CLOUDFLARE_ACCOUNT_ID: "account",
      CLOUDFLARE_API_TOKEN: "test-only",
    }, workersFetch);
    expect(workers.ok).toBe(true);
    if (!workers.ok) return;

    await expect(workers.model.completeWithJsonSchema?.("synthetic prompt", {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    })).resolves.toEqual({
      text: '{"value":"synthetic result"}',
      usage: { promptTokens: 29, completionTokens: 11, totalTokens: 40 },
    });
    expect(requestUrl).toBe(`https://api.cloudflare.com/client/v4/accounts/account/ai/run/${WORKERS_AI_MODEL}`);
    expect(requestBody).toMatchObject({
      tool_choice: "required",
      temperature: 0,
      tools: [{
        name: "return_structured_output",
        parameters: { type: "object", required: ["value"] },
      }],
    });
  });

  it("refuses missing or unexpected Workers AI structured tool calls", async () => {
    for (const tool_calls of [[], [{ name: "other_tool", arguments: {} }]]) {
      const fetchImpl = (async () => new Response(JSON.stringify({ result: { tool_calls } }), { status: 200 })) as typeof fetch;
      const workers = resolveFreeTextModel({
        AEQUITAS_PIPELINE_ENABLED: "true",
        AEQUITAS_PIPELINE_PROVIDER: "workers-ai",
        CLOUDFLARE_ACCOUNT_ID: "account",
        CLOUDFLARE_API_TOKEN: "test-only",
      }, fetchImpl);
      expect(workers.ok).toBe(true);
      if (workers.ok) await expect(workers.model.completeWithJsonSchema?.("synthetic prompt", {})).rejects.toThrow();
    }
  });

  it("does not invent token counts when the provider omits usage metadata", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "{}" }] } }] }), { status: 200 })) as typeof fetch;
    const resolved = resolveFreeTextModel({ AEQUITAS_PIPELINE_ENABLED: "true", GEMINI_API_KEY: "test-only" }, fetchImpl);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      await expect(resolved.model.completeWithUsage?.("synthetic prompt")).resolves.toEqual({ text: "{}", usage: undefined });
    }
  });
});
