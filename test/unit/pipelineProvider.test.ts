import { describe, expect, it } from "vitest";
import { AGENT_OUTPUT_JSON_SCHEMA } from "../../src/domain/caseAgent/output";
import {
  GEMINI_FLASH_MODEL,
  VERTEX_CANADA_LOCATION,
  VERTEX_CANADA_MODEL,
  WORKERS_AI_MODEL,
  caseDataProviderApprovalIdentity,
  resolveCaseDataModel,
  resolveFreeTextModel,
  type VertexAiClient,
  type VertexAiClientFactory,
} from "../../src/domain/pipeline/provider";
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

  it("uses the Montréal Vertex AI route with bounded, single-request structured output", async () => {
    let clientIdentity: { project: string; location: string } | undefined;
    let latestRequest: Parameters<VertexAiClient["models"]["generateContent"]>[0] | undefined;
    const factory: VertexAiClientFactory = (input) => {
      clientIdentity = { project: input.project, location: input.location };
      return {
        models: {
          async generateContent(request) {
            latestRequest = request;
            return {
              text: "{\"ok\":true}",
              usageMetadata: { promptTokenCount: 23, candidatesTokenCount: 9, totalTokenCount: 32 },
            };
          },
        },
      };
    };
    const configured = resolveFreeTextModel({
      AEQUITAS_PIPELINE_ENABLED: "true",
      AEQUITAS_PIPELINE_PROVIDER: "vertex-ai",
      AEQUITAS_VERTEX_PROJECT_ID: "synthetic-project",
    }, fetch, factory);

    expect(configured.ok).toBe(true);
    if (!configured.ok) return;
    expect(configured.model.provider).toBe("vertex-ai");
    expect(configured.model.model).toBe(VERTEX_CANADA_MODEL);
    await expect(configured.model.completeWithJsonSchema?.("synthetic prompt", {
      $schema: "not-sent",
      type: "object",
      properties: { reason: { type: "string", pattern: "^supported", minLength: 2 } },
      required: ["reason"],
      additionalProperties: false,
    }, "Keep the system instruction separate.")).resolves.toEqual({
      text: "{\"ok\":true}",
      usage: { promptTokens: 23, completionTokens: 9, totalTokens: 32 },
    });
    expect(clientIdentity).toEqual({ project: "synthetic-project", location: VERTEX_CANADA_LOCATION });
    expect(latestRequest).toMatchObject({
      model: VERTEX_CANADA_MODEL,
      contents: "synthetic prompt",
      config: {
        temperature: 0,
        maxOutputTokens: 16_000,
        responseMimeType: "application/json",
        automaticContinuation: false,
        systemInstruction: "Keep the system instruction separate.",
        responseJsonSchema: {
          type: "object",
          properties: { reason: { type: "string" } },
          required: ["reason"],
          additionalProperties: false,
        },
      },
    });
  });

  it("requires separate provider-terms and exact Vertex data-handling review before case data", () => {
    const env = {
      AEQUITAS_PIPELINE_ENABLED: "true",
      AEQUITAS_PIPELINE_PROVIDER: "vertex-ai",
      AEQUITAS_VERTEX_PROJECT_ID: "synthetic-project",
    };
    const identity = `vertex-ai:synthetic-project:${VERTEX_CANADA_LOCATION}:${VERTEX_CANADA_MODEL}`;
    expect(caseDataProviderApprovalIdentity(env)).toBe(identity);
    expect(resolveCaseDataModel(env).ok).toBe(false);
    expect(resolveCaseDataModel({
      ...env,
      AEQUITAS_AI_PROVIDER_TERMS_REVIEWED_FOR: identity,
    }).ok).toBe(false);
    expect(resolveCaseDataModel({
      ...env,
      AEQUITAS_AI_PROVIDER_TERMS_REVIEWED_FOR: identity,
      AEQUITAS_VERTEX_DATA_HANDLING_REVIEWED_FOR: identity,
    }).ok).toBe(true);
    expect(resolveCaseDataModel({
      ...env,
      AEQUITAS_VERTEX_LOCATION: "us-central1",
      AEQUITAS_AI_PROVIDER_TERMS_REVIEWED_FOR: identity,
      AEQUITAS_VERTEX_DATA_HANDLING_REVIEWED_FOR: identity,
    }).ok).toBe(false);
    expect(resolveCaseDataModel({
      ...env,
      AEQUITAS_VERTEX_MODEL: "gemini-3.8-flash",
      AEQUITAS_AI_PROVIDER_TERMS_REVIEWED_FOR: identity,
      AEQUITAS_VERTEX_DATA_HANDLING_REVIEWED_FOR: identity,
    }).ok).toBe(false);
  });

  it("fails closed for case data until provider terms and Gemini's paid tier are confirmed", () => {
    const env = {
      AEQUITAS_PIPELINE_ENABLED: "true",
      GEMINI_PROJECT_ID: "synthetic-project",
      GEMINI_API_KEY: "synthetic-test-only",
    };
    expect(resolveCaseDataModel(env).ok).toBe(false);
    expect(resolveCaseDataModel({
      ...env,
      AEQUITAS_AI_PROVIDER_TERMS_REVIEWED: "true",
      AEQUITAS_GEMINI_PAID_TIER_CONFIRMED: "true",
    }).ok).toBe(false);
    const reviewedGemini = {
      ...env,
      AEQUITAS_AI_PROVIDER_TERMS_REVIEWED_FOR: "gemini:synthetic-project:gemini-3.8-flash",
    };
    expect(resolveCaseDataModel(reviewedGemini).ok).toBe(false);
    expect(resolveCaseDataModel({
      ...reviewedGemini,
      AEQUITAS_GEMINI_PAID_TIER_CONFIRMED_FOR: "synthetic-project",
    }).ok).toBe(true);
    expect(resolveCaseDataModel({
      AEQUITAS_PIPELINE_ENABLED: "true",
      AEQUITAS_PIPELINE_PROVIDER: "workers-ai",
      CLOUDFLARE_ACCOUNT_ID: "account",
      CLOUDFLARE_API_TOKEN: "token",
      AEQUITAS_AI_PROVIDER_TERMS_REVIEWED_FOR: `workers-ai:account:${WORKERS_AI_MODEL}`,
    }).ok).toBe(true);
  });

  it("invalidates provider approval when the account, project or model changes", () => {
    const gemini = {
      AEQUITAS_PIPELINE_ENABLED: "true",
      GEMINI_PROJECT_ID: "approved-project",
      GEMINI_API_KEY: "synthetic-test-only",
      AEQUITAS_AI_PROVIDER_TERMS_REVIEWED_FOR: "gemini:approved-project:gemini-3.8-flash",
      AEQUITAS_GEMINI_PAID_TIER_CONFIRMED_FOR: "approved-project",
    };
    expect(resolveCaseDataModel(gemini).ok).toBe(true);
    expect(resolveCaseDataModel({ ...gemini, GEMINI_PROJECT_ID: "other-project" }).ok).toBe(false);
    expect(resolveCaseDataModel({ ...gemini, GEMINI_MODEL: "gemini-other-model" }).ok).toBe(false);
    expect(resolveCaseDataModel({ ...gemini, AEQUITAS_GEMINI_PAID_TIER_CONFIRMED_FOR: "other-project" }).ok).toBe(false);

    const workers = {
      AEQUITAS_PIPELINE_ENABLED: "true",
      AEQUITAS_PIPELINE_PROVIDER: "workers-ai",
      CLOUDFLARE_ACCOUNT_ID: "approved-account",
      CLOUDFLARE_API_TOKEN: "synthetic-test-only",
      AEQUITAS_AI_PROVIDER_TERMS_REVIEWED_FOR: `workers-ai:approved-account:${WORKERS_AI_MODEL}`,
    };
    expect(resolveCaseDataModel(workers).ok).toBe(true);
    expect(resolveCaseDataModel({
      ...workers,
      AEQUITAS_PIPELINE_PROVIDER: "cloudflare",
      AEQUITAS_AI_PROVIDER_TERMS_REVIEWED_FOR: `workers-ai:approved-account:${WORKERS_AI_MODEL}`,
    }).ok).toBe(true);
    expect(resolveCaseDataModel({ ...workers, CLOUDFLARE_ACCOUNT_ID: "other-account" }).ok).toBe(false);
    expect(resolveCaseDataModel({ ...workers, AEQUITAS_WORKERS_AI_MODEL: "@cf/google/another-model" }).ok).toBe(false);
  });

  it("returns only provider-reported token counts for Gemini and Workers AI", async () => {
    const requests: Array<{ body: Record<string, unknown>; url: string }> = [];
    const geminiFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown>, url: String(input) });
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: "{}" }] } }],
        usageMetadata: { promptTokenCount: 21, candidatesTokenCount: 8, totalTokenCount: 29 },
      }), { status: 200 });
    }) as typeof fetch;
    const gemini = resolveFreeTextModel({ AEQUITAS_PIPELINE_ENABLED: "true", GEMINI_API_KEY: "test-only" }, geminiFetch);
    expect(gemini.ok).toBe(true);
    if (gemini.ok) {
      await expect(gemini.model.completeWithUsage?.("synthetic prompt", "Keep rules separate.")).resolves.toEqual({
        text: "{}",
        usage: { promptTokens: 21, completionTokens: 8, totalTokens: 29 },
      });
    }

    const workersFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown>, url: String(input) });
      return new Response(JSON.stringify({
        result: { response: "{}", usage: { prompt_tokens: 34, completion_tokens: 13, total_tokens: 47 } },
      }), { status: 200 });
    }) as typeof fetch;
    const workers = resolveFreeTextModel({
      AEQUITAS_PIPELINE_ENABLED: "true",
      AEQUITAS_PIPELINE_PROVIDER: "workers-ai",
      CLOUDFLARE_ACCOUNT_ID: "account",
      CLOUDFLARE_API_TOKEN: "test-only",
    }, workersFetch);
    expect(workers.ok).toBe(true);
    if (workers.ok) {
      await expect(workers.model.completeWithUsage?.("synthetic prompt", "Keep rules separate.")).resolves.toEqual({
        text: "{}",
        usage: { promptTokens: 34, completionTokens: 13, totalTokens: 47 },
      });
    }
    expect(requests[0].body).toMatchObject({
      systemInstruction: { parts: [{ text: "Keep rules separate." }] },
      contents: [{ role: "user", parts: [{ text: "synthetic prompt" }] }],
    });
    expect(requests[1].body).toMatchObject({
      messages: [
        { role: "system", content: "Keep rules separate." },
        { role: "user", content: "synthetic prompt" },
      ],
    });
  });

  it("requests one schema-bound tool call for Workers AI structured completions", async () => {
    let requestUrl = "";
    let requestBody: Record<string, unknown> | undefined;
    const workersFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestUrl = String(input);
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        choices: [{ message: { tool_calls: [{
          type: "function",
          function: { name: "return_structured_output", arguments: JSON.stringify({ value: "synthetic result" }) },
        }] } }],
        usage: { prompt_tokens: 29, completion_tokens: 11, total_tokens: 40 },
      }), { status: 200 });
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
    }, "Keep rules separate.")).resolves.toEqual({
      text: '{"value":"synthetic result"}',
      usage: { promptTokens: 29, completionTokens: 11, totalTokens: 40 },
    });
    expect(requestUrl).toBe("https://api.cloudflare.com/client/v4/accounts/account/ai/v1/chat/completions");
    expect(requestBody).toMatchObject({
      model: WORKERS_AI_MODEL,
      messages: [
        { role: "system", content: "Keep rules separate." },
        { role: "user", content: "synthetic prompt" },
      ],
      tool_choice: "required",
      parallel_tool_calls: false,
      temperature: 0,
      max_completion_tokens: 16_000,
      tools: [{
        type: "function",
        function: {
          name: "return_structured_output",
          parameters: { type: "object", required: ["value"] },
        },
      }],
    });
  });

  it("uses Gemini structured output and removes schema keywords outside its supported subset", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const geminiFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent");
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: '{"value":"synthetic result"}' }] } }],
        usageMetadata: { promptTokenCount: 29, candidatesTokenCount: 11, totalTokenCount: 40 },
      }), { status: 200 });
    }) as typeof fetch;
    const gemini = resolveFreeTextModel({
      AEQUITAS_PIPELINE_ENABLED: "true",
      GEMINI_API_KEY: "test-only",
    }, geminiFetch);
    expect(gemini.ok).toBe(true);
    if (!gemini.ok) return;

    await expect(gemini.model.completeWithJsonSchema?.("synthetic prompt", {
      type: "object",
      properties: {
        value: { type: "string", minLength: 1, maxLength: 30, pattern: "^synthetic", description: "A value." },
        count: { type: "integer", minimum: 0, maximum: 50, exclusiveMinimum: 0 },
        labels: { type: "array", minItems: 1, maxItems: 4, items: { type: "string", pattern: "^[A-Z]+$" } },
      },
      required: ["value", "count", "labels"],
      additionalProperties: false,
      unsupportedRootKeyword: true,
    }, "Keep rules separate.")).resolves.toEqual({
      text: '{"value":"synthetic result"}',
      usage: { promptTokens: 29, completionTokens: 11, totalTokens: 40 },
    });

    expect(requestBody).toEqual({
      systemInstruction: { parts: [{ text: "Keep rules separate." }] },
      contents: [{ role: "user", parts: [{ text: "synthetic prompt" }] }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 16_000,
        responseFormat: {
          text: {
            mimeType: "APPLICATION_JSON",
            schema: {
              type: "object",
              properties: {
                value: { type: "string", description: "A value." },
                count: { type: "integer", minimum: 0, maximum: 50 },
                labels: { type: "array", minItems: 1, maxItems: 4, items: { type: "string" } },
              },
              required: ["value", "count", "labels"],
              additionalProperties: false,
            },
          },
        },
      },
    });
  });

  it("converts the production case-agent schema to Gemini's supported subset", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const geminiFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: "{}" }] } }],
      }), { status: 200 });
    }) as typeof fetch;
    const gemini = resolveFreeTextModel({
      AEQUITAS_PIPELINE_ENABLED: "true",
      GEMINI_API_KEY: "test-only",
    }, geminiFetch);
    expect(gemini.ok).toBe(true);
    if (!gemini.ok) return;

    await gemini.model.completeWithJsonSchema?.("synthetic prompt", AGENT_OUTPUT_JSON_SCHEMA);

    const generationConfig = requestBody?.generationConfig as {
      responseFormat?: { text?: { schema?: unknown } };
    } | undefined;
    const schema = generationConfig?.responseFormat?.text?.schema;
    expect(schema).toMatchObject({
      type: "object",
      properties: {
        needs_human: { anyOf: [{ type: "string" }, { type: "null" }] },
        summary_claims: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          items: {
            type: "object",
            properties: {
              text: { type: "string" },
              citation_ids: { type: "array", items: { type: "string" } },
            },
          },
        },
        citations: {
          type: "array",
          items: { type: "object", properties: { evidence_item_id: { type: "string", format: "uuid" } } },
        },
      },
    });
    expect(JSON.stringify(schema)).not.toMatch(/"(?:pattern|minLength|maxLength|exclusiveMinimum|exclusiveMaximum)"\s*:/);
  });

  it("refuses missing or unexpected Workers AI structured tool calls", async () => {
    for (const tool_calls of [[], [{ type: "function", function: { name: "other_tool", arguments: "{}" } }]]) {
      const fetchImpl = (async () => new Response(JSON.stringify({ choices: [{ message: { tool_calls } }] }), { status: 200 })) as typeof fetch;
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
