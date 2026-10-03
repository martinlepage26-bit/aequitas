import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cfg } from "./lib/config";
import { Client, rawRequest, setSuite } from "./lib/http";
import { observe } from "./lib/evidence";
import { closePool } from "./lib/db";
import { makeAccount, makeAdmin, type Account } from "./lib/world";

/**
 * Area 7 (HTTP behaviour) and the HTTP half of Area 1 (redirects), against the PRODUCTION build (`next start`).
 * Application behaviour only: nothing here can distinguish the app from Railway's edge, which is not in the path.
 */
const anon = () => new Client("anon");
let complainant: Account, admin: Account;
beforeAll(async () => { setSuite("01-http-production"); [complainant, admin] = [await makeAccount("COMPLAINANT", "http-comp"), await makeAdmin("http-admin")]; });
afterAll(async () => { await closePool(); });

const REQUIRED = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};

describe("health", () => {
  it("GET /api/health reports ok, the release commit, and is uncacheable", async () => {
    const res = await anon().get("/api/health");
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ status: "ok", release: cfg.releaseCommit });
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
  });
  it("HEAD works and POST/PUT/DELETE are refused with 405", async () => {
    const head = await rawRequest({ method: "HEAD", path: "/api/health" });
    expect(head.status).toBe(200);
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) expect((await anon().request(method, "/api/health")).status).toBe(405);
  });
});

describe("security headers on the production build", () => {
  const surfaces: Array<[string, string]> = [["/api/health", "api 200"], ["/fr-CA", "fr page"], ["/en-CA", "en page"], ["/", "root"], ["/api/cases/none", "api 401"], ["/fr-CA/does-not-exist", "page 404"], ["/api/does-not-exist", "api 404"]];
  for (const [path, label] of surfaces) {
    it(`${label} (${path}) carries the full header set`, async () => {
      const res = await anon().get(path);
      for (const [name, value] of Object.entries(REQUIRED)) expect(res.headers.get(name), `${name} on ${path}`).toBe(value);
      expect(res.headers.get("strict-transport-security"), `HSTS on ${path}`).toMatch(/max-age=\d{7,}/);
      expect(res.headers.get("x-powered-by"), `x-powered-by on ${path}`).toBeNull();
      const csp = res.headers.get("content-security-policy") ?? "";
      expect(csp, `CSP on ${path}`).toContain("frame-ancestors 'none'");
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("base-uri 'self'");
      expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
      expect(csp).not.toContain("unsafe-eval");
      expect(res.headers.get("cache-control"), `cache-control on ${path}`).toMatch(/no-store/);
    });
  }
  it("the CSP nonce is fresh per request and the HTML's script tags carry it", async () => {
    const a = await anon().get("/fr-CA"), b = await anon().get("/fr-CA");
    const nonce = (r: typeof a) => /'nonce-([^']+)'/.exec(r.headers.get("content-security-policy") ?? "")?.[1];
    expect(nonce(a)).toBeTruthy();
    expect(nonce(a)).not.toBe(nonce(b));
    const scripts = [...a.text.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
    expect(scripts.length).toBeGreaterThan(0);
    for (const tag of scripts) expect(tag, "every <script> tag has the request nonce").toContain(`nonce="${nonce(a)}"`);
  });
  it("static assets are served without a CSP but keep nosniff/frame headers", async () => {
    const page = await anon().get("/fr-CA");
    const asset = /\/_next\/static\/[^"']+\.js/.exec(page.text)?.[0];
    expect(asset).toBeTruthy();
    const res = await anon().get(asset!);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });
  it("sends no permissive CORS headers", async () => {
    for (const path of ["/api/health", "/api/cases"]) {
      const res = await anon().request("OPTIONS", path, { headers: { origin: "https://evil.invalid", "access-control-request-method": "POST" } });
      expect(res.headers.get("access-control-allow-origin"), path).toBeNull();
      const get = await anon().get(path, { headers: { origin: "https://evil.invalid" } });
      expect(get.headers.get("access-control-allow-origin"), path).toBeNull();
    }
  });
});

describe("redirects and locale handling", () => {
  it("/ is served (rewrite, 200) and /fr, /en redirect to the full locale", async () => {
    expect((await anon().get("/")).status).toBe(200);
    for (const [from, to] of [["/fr", "/fr-CA"], ["/en", "/en-CA"]]) {
      const res = await anon().get(from);
      expect([307, 308]).toContain(res.status);
      expect(res.headers.get("location")).toBe(to);
    }
  });
  const protectedPaths = ["/cases", "/cases/new", "/cases/00000000-0000-4000-8000-000000000000", "/admin/invites"];
  for (const locale of ["fr-CA", "en-CA"]) {
    for (const p of protectedPaths) {
      it(`unauthenticated /${locale}${p} redirects to /${locale}/auth/sign-in and keeps the destination`, async () => {
        const res = await anon().get(`/${locale}${p}`);
        expect([307, 308]).toContain(res.status);
        const location = res.headers.get("location") ?? "";
        expect(location).toBe(`/${locale}/auth/sign-in?next=${encodeURIComponent(`/${locale}${p}`)}`);
      });
    }
  }
  it("the legacy /auth/sign-in route forwards locale and destination", async () => {
    const res = await anon().get("/auth/sign-in?locale=en-CA&next=%2Fen-CA%2Fcases");
    expect([307, 308]).toContain(res.status);
    expect(res.headers.get("location")).toBe(`/en-CA/auth/sign-in?next=${encodeURIComponent("/en-CA/cases")}`);
    const unknown = await anon().get("/auth/sign-in?locale=de-DE");
    expect(unknown.headers.get("location")).toBe("/fr-CA/auth/sign-in");
  });
  const hostile = ["//evil.invalid", "https://evil.invalid/x", "/\\evil.invalid", "/fr-CA/cases/../../evil", "/en-CA/cases", "/fr-CA/casesx", "javascript:alert(1)", "/fr-CA/cases%0d%0aSet-Cookie:x=1", "/fr-CA/admin/invites/extra"];
  for (const next of hostile) {
    it(`sign-in page neutralises hostile next=${JSON.stringify(next).slice(0, 48)}`, async () => {
      const res = await anon().get(`/fr-CA/auth/sign-in?next=${encodeURIComponent(next)}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("location")).toBeNull();
      expect(res.headers.getSetCookie().filter((c) => /^(aequitas_session|aequitas_webauthn_challenge)=/.test(c))).toEqual([]); // NEXT_LOCALE preference cookie is expected
      // The raw value may appear inside Next's own JSON-escaped router-state payload; it must never reach a link,
      // a form action or the sanitised returnTo prop that AuthForm navigates to after sign-in.
      expect(res.text).not.toMatch(/(?:href|action|src)="[^"]*evil\.invalid/);
      const returnTo = /\\?"returnTo\\?":\\?"([^"\\]*)/.exec(res.text)?.[1];
      expect(returnTo, "sanitised returnTo prop is present").toBeTruthy();
      expect(returnTo).toBe("/fr-CA/cases");
    });
  }
  it("a signed-in user visiting sign-in is not redirected away (observation only)", async () => {
    const res = await complainant.client.get("/fr-CA/auth/sign-in");
    observe("01-http-production", "signed-in-visits-signin", { status: res.status, location: res.headers.get("location") });
    expect(res.status).toBeLessThan(500);
  });
});

describe("malformed percent-encoding (production mode)", () => {
  // Raw, unescaped percent sequences. At Railway these never reach the app (gateway error, not testable here);
  // this checks what the APPLICATION does if they do arrive, e.g. from another proxy or a direct hit.
  const malformed = ["/%", "/%zz", "/%E0%A4%A", "/%E0%A4", "/fr-CA/%", "/fr-CA/cases/%", "/fr-CA/cases/%zz", "/fr-CA/invite/%", "/fr-CA/invite/%E0%A4%A", "/fr-CA/invite/abc%", "/en-CA/invite/%ZZ",
    "/api/cases/%/events", "/api/cases/%zz", "/api/cases/%E0%A4%A/export", "/api/health%", "/api/auth/webauthn/%", "/%C0%AF", "/%ED%A0%80", "/fr-CA/invite/%25%", "/fr-CA/invite/%2525%", "/fr-CA/invite/%252"];
  for (const path of malformed) {
    it(`GET ${path} -> 400 from the app, never 5xx`, async () => {
      const res = await rawRequest({ path });
      observe("01-http-production", "malformed-percent", { path, status: res.status, body: res.text.slice(0, 120) });
      expect(res.status, `body: ${res.text.slice(0, 120)}`).toBe(400);
    });
  }
  const wellFormed = ["/%25", "/fr-CA/invite/%2525", "/fr-CA/invite/a%2Fb", "/fr-CA/invite/%E2%82%AC", "/api/cases/%2e%2e", "/fr-CA/cases/%252e%252e"];
  for (const path of wellFormed) {
    it(`GET ${path} (valid encoding) is handled without a 5xx`, async () => {
      const res = await rawRequest({ path });
      observe("01-http-production", "wellformed-percent", { path, status: res.status });
      expect(res.status).toBeLessThan(500);
    });
  }
  it("malformed query strings do not crash routes or pages", async () => {
    for (const path of ["/api/health?x=%", "/fr-CA/auth/sign-in?next=%", "/fr-CA/auth/sign-in?next=%E0%A4%A", "/fr-CA?%zz=1", "/api/cases/x/events?a=%&b=%E0"]) {
      const res = await rawRequest({ path });
      observe("01-http-production", "malformed-query", { path, status: res.status });
      expect(res.status, path).toBeLessThan(500);
    }
  });
  it("POST with a malformed path is rejected the same way", async () => {
    const res = await rawRequest({ method: "POST", path: "/api/cases/%zz/submit", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(400);
  });
  it("the server is still healthy after the malformed-URL barrage", async () => {
    expect((await anon().get("/api/health")).status).toBe(200);
  });
});

describe("bad JSON and bad bodies on every API route", () => {
  const caseId = "00000000-0000-4000-8000-000000000000";
  const routes: Array<[string, string]> = [
    ["POST", "/api/cases"], ["POST", `/api/cases/${caseId}/submit`], ["POST", `/api/cases/${caseId}/open-intake`], ["POST", `/api/cases/${caseId}/close-intake`],
    ["POST", `/api/cases/${caseId}/positions`], ["POST", `/api/cases/${caseId}/chronology`], ["POST", `/api/cases/${caseId}/consent`], ["POST", `/api/cases/${caseId}/withdraw`],
    ["POST", `/api/cases/${caseId}/draft-requests`], ["PATCH", `/api/cases/${caseId}/draft`], ["POST", `/api/cases/${caseId}/close`], ["POST", `/api/recommendations/${caseId}/issue`],
    ["POST", "/api/auth/webauthn/register"], ["POST", "/api/auth/webauthn/authenticate"], ["POST", "/api/auth/invite/claim"], ["POST", "/api/auth/invite"], ["DELETE", "/api/auth/invite"],
  ];
  const bodies: Array<[string, string]> = [["truncated", "{"], ["null", "null"], ["array", "[]"], ["string", '"x"'], ["number", "123"], ["empty", ""], ["binary", "\u0000\u0001\u0002"], ["deep nesting", "[".repeat(50_000)]];
  for (const [method, path] of routes) {
    it(`${method} ${path.replace(caseId, ":id")} never answers 5xx to a bad body (anonymous, then authenticated)`, async () => {
      for (const [label, body] of bodies) {
        const anonRes = await anon().request(method, path, { body, headers: { "content-type": "application/json" } });
        expect(anonRes.status, `anon ${label}`).toBeLessThan(500);
        const authRes = await admin.client.request(method, path, { body, headers: { "content-type": "application/json" } });
        expect(authRes.status, `admin ${label}: ${authRes.text.slice(0, 150)}`).toBeLessThan(500);
        expect([400, 401, 403, 404, 405, 409]).toContain(authRes.status);
      }
    });
  }
  it("evidence upload endpoints reject non-multipart and truncated multipart bodies with 400", async () => {
    for (const path of [`/api/cases/${caseId}/evidence`, `/api/cases/${caseId}/evidence/${caseId}/supersede`]) {
      const plain = await complainant.client.post(path, { not: "multipart" });
      expect(plain.status, path).toBe(400);
      const truncated = await complainant.client.request("POST", path, { body: "--x\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a\"\r\n\r\nabc", headers: { "content-type": "multipart/form-data; boundary=x" } });
      expect(truncated.status, path).toBe(400);
    }
  });
});

describe("unsupported methods, oversized requests and file exposure", () => {
  it("GET on POST-only routes answers 405", async () => {
    for (const path of ["/api/cases/x/submit", "/api/cases/x/consent", "/api/auth/sign-out", "/api/auth/webauthn/register", "/api/cases/x/withdraw"]) {
      const res = await complainant.client.get(path);
      expect(res.status, path).toBe(405);
      // RFC 9110 expects an Allow header on 405; Next.js 16.3.8 route handlers omit it. Recorded, not asserted:
      // this is framework behaviour, not application code.
      observe("01-http-production", "405-allow-header", { path, allow: res.headers.get("allow") });
    }
  });
  it("an absurdly long URL and a huge header are refused without killing the server", async () => {
    const long = await rawRequest({ path: "/" + "a".repeat(40_000) }).catch((e: Error) => ({ status: -1, text: e.message, headers: {} }));
    observe("01-http-production", "long-url", { status: long.status });
    const big = await rawRequest({ path: "/api/health", headers: { "x-big": "b".repeat(60_000) } }).catch((e: Error) => ({ status: -1, text: e.message, headers: {} }));
    observe("01-http-production", "huge-header", { status: big.status });
    expect((await anon().get("/api/health")).status).toBe(200);
  });
  it("source, config and dependency files are not served", async () => {
    for (const path of ["/.env", "/.env.local", "/.git/config", "/package.json", "/src/proxy.ts", "/prisma/schema.prisma", "/next.config.mjs", "/_next/../package.json", "/DECISIONS.md", "/docs/aequitas-core-backend.md", "/node_modules/next/package.json", "/Aequitas%20Core.txt"]) {
      const res = await rawRequest({ path });
      expect([400, 404], path).toContain(res.status);
      expect(res.text, path).not.toMatch(/DATABASE_URL|SESSION_SECRET|datasource db|"name": "aequitas"/);
    }
  });
  it("the documented POST /api/cases/:id/recommendation alias exists (docs/aequitas-core-backend.md says it does)", async () => {
    const res = await admin.client.post("/api/cases/00000000-0000-4000-8000-000000000000/recommendation", {});
    observe("01-http-production", "documented-alias-recommendation", { status: res.status });
    expect(res.status, "documented compatibility alias should not be a route-not-found 404").not.toBe(404);
  });
});
