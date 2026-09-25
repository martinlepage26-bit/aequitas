/**
 * Legal-research lookup for the real Aequitas Core drafting pipeline.
 * (The M0 demo's separate, unauthenticated /api/legal-context route was
 * removed with the rest of that demo; see DECISIONS.md, demo readiness.)
 *
 * Best-effort only: any failure (unconfigured, timeout, non-2xx, malformed
 * body) returns an empty array rather than throwing. A missing legal source
 * is an honest "no research available" case already handled everywhere
 * else in this codebase (see draftRecommendation.ts's ANTHROPIC_API_KEY
 * guard) — it must never become a fabricated citation.
 */

export interface LegalResearchResult {
  id: string;
  title: string;
  citation?: string;
  body: string;
  url?: string;
}

export async function fetchLegalResearch(query: string, limit = 3): Promise<LegalResearchResult[]> {
  const baseUrl = process.env.LEGIPRO_API_URL;
  const token = process.env.LEGIPRO_API_TOKEN;
  if (!baseUrl || !token) return [];

  try {
    const url = new URL("/v0/search/routed", baseUrl);
    url.searchParams.set("q", query);
    url.searchParams.set("limit", String(limit));
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return [];
    const payload: unknown = await response.json();
    const rawResults = payload && typeof payload === "object" && Array.isArray((payload as { results?: unknown }).results)
      ? (payload as { results: unknown[] }).results
      : [];
    return rawResults
      .filter((r: unknown): r is Record<string, unknown> => typeof r === "object" && r !== null)
      .map((r, i) => ({
        id: typeof r.id === "string" && r.id ? r.id : `legipro-${i}`,
        title: typeof r.title === "string" ? r.title : "Untitled source",
        citation: typeof r.citation === "string" ? r.citation : undefined,
        body: typeof r.snippet === "string" ? r.snippet : typeof r.text === "string" ? r.text : "",
        url: typeof r.url === "string" ? r.url : undefined,
      }))
      .filter((r) => r.body.length > 0)
      .slice(0, limit);
  } catch {
    return [];
  }
}
