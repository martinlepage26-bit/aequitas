import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchLegalResearch } from "../../src/lib/legipro";

describe("LegiPro legal-research lookup", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("returns no results without throwing when unconfigured, and makes no network call", async () => {
    vi.stubEnv("LEGIPRO_API_URL", "");
    vi.stubEnv("LEGIPRO_API_TOKEN", "");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(await fetchLegalResearch("query")).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("maps a successful response into cite-able sources", async () => {
    vi.stubEnv("LEGIPRO_API_URL", "http://legipro.test");
    vi.stubEnv("LEGIPRO_API_TOKEN", "test-token");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          results: [
            { id: "cqlr-p40-1-s37", title: "Consumer Protection Act", citation: "CQLR c P-40.1, s. 37", snippet: "Goods must be fit for the purposes for which goods of that kind are ordinarily used." },
            { title: "No usable text", snippet: "" },
          ],
        }),
      })
    );
    const results = await fetchLegalResearch("consumer goods dispute");
    expect(results).toEqual([
      { id: "cqlr-p40-1-s37", title: "Consumer Protection Act", citation: "CQLR c P-40.1, s. 37", body: "Goods must be fit for the purposes for which goods of that kind are ordinarily used.", url: undefined },
    ]);
  });

  it("returns no results on a non-2xx response, never throwing", async () => {
    vi.stubEnv("LEGIPRO_API_URL", "http://legipro.test");
    vi.stubEnv("LEGIPRO_API_TOKEN", "test-token");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    expect(await fetchLegalResearch("query")).toEqual([]);
  });

  it("returns no results when the request throws (timeout, network failure)", async () => {
    vi.stubEnv("LEGIPRO_API_URL", "http://legipro.test");
    vi.stubEnv("LEGIPRO_API_TOKEN", "test-token");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")));
    expect(await fetchLegalResearch("query")).toEqual([]);
  });
});
