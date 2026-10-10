import { describe, expect, it } from "vitest";
import { GEMINI_FLASH_MODEL, WORKERS_AI_MODEL, resolveFreeTextModel } from "../../src/domain/pipeline/provider";
import { pipelineEnabled } from "../../src/domain/pipeline/flag";

describe("free pipeline provider", () => {
  it("defaults to the current Gemini flash model and a Workers AI model on the free allocation", () => {
    expect(GEMINI_FLASH_MODEL).toBe("gemini-3.8-flash");
    expect(WORKERS_AI_MODEL).toBe("@cf/meta/llama-3.1-8b-instruct-fp8");
  });

  it("stays off unless the flag is exactly true", () => {
    expect(pipelineEnabled({})).toBe(false);
    expect(pipelineEnabled({ AEQUITAS_PIPELINE_ENABLED: "false" })).toBe(false);
    expect(pipelineEnabled({ AEQUITAS_PIPELINE_ENABLED: "true" })).toBe(true);
  });

  it("does not call the network for a paid provider or a missing free key", async () => {
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
});
