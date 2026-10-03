import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../src/lib/prisma";
import { signPayload, verifyPayload } from "../../src/lib/signedCookie";
import { SESSION_COOKIE } from "../../src/lib/session";
import { CHALLENGE_COOKIE, ORIGIN, RP_ID } from "../../src/lib/webauthn";
import { issueInviteToken } from "../../src/lib/invite";
import { CookieJar, startNextDev, type DevServer } from "../helpers/nextDevServer";
import { createAuthenticationResponse, createRegistrationResponse } from "../helpers/softAuthenticator";

let server: DevServer;
let base: string;
let user: { id: string; email: string };
let admin: { id: string };
let caseId: string;
const cookie = (userId: string, globalRole: string) => `${SESSION_COOKIE}=${signPayload({ purpose: "session", userId, globalRole, authMethod: "passkey" }, 3600)}`;
const post = (path: string, body: unknown, cookies?: string) => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", ...(cookies ? { Cookie: cookies } : {}) }, body: JSON.stringify(body) });

beforeAll(async () => {
  server = await startNextDev(3425); base = server.baseUrl;
  user = await prisma.user.create({ data: { email: `security-${randomUUID()}@example.com`, displayName: "Private case owner", globalRole: "COMPLAINANT" } });
  const respondent = await prisma.user.create({ data: { email: `security-r-${randomUUID()}@example.com`, displayName: "Respondent", globalRole: "RESPONDENT" } });
  admin = await prisma.user.create({ data: { email: `security-admin-${randomUUID()}@example.com`, displayName: "Admin", globalRole: "ADMIN" } });
  const row = await prisma.case.create({ data: { referenceNumber: `PRIVATE-${randomUUID()}`, complainantId: user.id, respondentId: respondent.id, state: "CLOSED" } });
  caseId = row.id;
}, 240_000);
afterAll(async () => { await server?.stop(); await prisma.$disconnect(); });

describe("Token purpose and sign-in privacy", () => {
  it("returns identical option shapes for known and unknown email addresses without a user id", async () => {
    const responses = await Promise.all([user.email, `unknown-${randomUUID()}@example.com`].map(email => post("/api/auth/webauthn/authenticate", { step: "options", email })));
    const options = [];
    for (const response of responses) {
      expect(response.status).toBe(200);
      const jar = new CookieJar(); jar.absorb(response);
      const payload = verifyPayload<Record<string, unknown>>(jar.get(CHALLENGE_COOKIE)!);
      expect(payload?.purpose).toBe("authenticate"); expect(payload).not.toHaveProperty("userId");
      const data = await response.json(); delete data.challenge; options.push(data);
    }
    expect(options[0]).toEqual(options[1]);
    expect(options[0]).not.toHaveProperty("allowCredentials");
  });

  it("rejects a public sign-in challenge and invite token when copied into the session cookie", async () => {
    const options = await post("/api/auth/webauthn/authenticate", { step: "options", email: user.email });
    const jar = new CookieJar(); jar.absorb(options);
    const tokens = [jar.get(CHALLENGE_COOKIE)!, issueInviteToken(user.id).token, signPayload({ userId: user.id, challenge: "legacy" }, 300), signPayload({ purpose: "session", userId: user.id }, 300)];
    for (const token of tokens) {
      const headers = { Cookie: `${SESSION_COOKIE}=${token}` };
      for (const suffix of ["", "/events", "/chronology", "/export"]) {
        expect((await fetch(`${base}/api/cases/${caseId}${suffix}`, { headers })).status).toBe(401);
      }
      const page = await fetch(`${base}/en-CA/cases/${caseId}`, { headers, redirect: "manual" });
      expect(page.status).toBe(307); expect(page.headers.get("location")).toContain("/en-CA/auth/sign-in?next=");
      expect((await post(`/api/cases/${caseId}/draft-requests`, {}, headers.Cookie)).status).toBe(401);
    }
  }, 60_000);

  it("still registers and authenticates with a real signed WebAuthn assertion", async () => {
    const email = `auth-valid-${randomUUID()}@example.com`;
    const registerJar = new CookieJar();
    const options = await post("/api/auth/webauthn/register", { step: "options", email, displayName: "Valid user", globalRole: "COMPLAINANT" });
    expect(options.status).toBe(200); registerJar.absorb(options);
    const registration = createRegistrationResponse(await options.json(), ORIGIN, RP_ID);
    const verified = await post("/api/auth/webauthn/register", { step: "verify", response: registration }, registerJar.header());
    expect(verified.status).toBe(200);
    const loginJar = new CookieJar();
    const loginOptions = await post("/api/auth/webauthn/authenticate", { step: "options", email });
    loginJar.absorb(loginOptions);
    const assertion = createAuthenticationResponse(registration.id, (await loginOptions.json()).challenge, ORIGIN, RP_ID);
    const login = await post("/api/auth/webauthn/authenticate", { step: "verify", response: assertion }, loginJar.header());
    expect(login.status).toBe(200); loginJar.absorb(login);
    expect(verifyPayload<{ purpose: string; globalRole: string }>(loginJar.get(SESSION_COOKIE)!)?.purpose).toBe("session");
    const signedIn = await fetch(base + "/en-CA/cases", { headers: { Cookie: loginJar.header() } });
    expect(signedIn.status).toBe(200); expect(await signedIn.text()).toContain("Sign out");
  });
});

describe("Revocation, access checks and page hardening", () => {
  it("revokes a link even after its claim ceremony has started", async () => {
    const issued = await post("/api/auth/invite", { email: `revoked-${randomUUID()}@example.com`, displayName: "Invitee", globalRole: "RESPONDENT" }, cookie(admin.id, "ADMIN"));
    expect(issued.status).toBe(200);
    const { invitationId, claimPath, userId } = await issued.json();
    const token = decodeURIComponent(claimPath.split("/").pop());
    const options = await post("/api/auth/invite/claim", { step: "options", token });
    const jar = new CookieJar(); jar.absorb(options);
    const response = createRegistrationResponse(await options.json(), ORIGIN, RP_ID);
    const revoked = await fetch(base + "/api/auth/invite", { method: "DELETE", headers: { Cookie: cookie(admin.id, "ADMIN"), "Content-Type": "application/json" }, body: JSON.stringify({ invitationId }) });
    expect(revoked.status).toBe(200);
    expect((await post("/api/auth/invite/claim", { step: "verify", token, response }, jar.header())).status).toBe(400);
    expect(await prisma.webAuthnCredential.count({ where: { userId } })).toBe(0);
  });

  it("hides inaccessible case existence before checking workflow state", async () => {
    const outsider = await prisma.user.create({ data: { email: `outsider-${randomUUID()}@example.com`, displayName: "Other manager", globalRole: "CASE_MANAGER" } });
    for (const id of [caseId, randomUUID()]) {
      const result = await post(`/api/cases/${id}/draft-requests`, {}, cookie(outsider.id, "CASE_MANAGER"));
      expect(result.status).toBe(404); expect(await result.json()).toEqual({ message: "Case not found." });
    }
  });

  it("records authorized administrator reads in the case's hash chain", async () => {
    expect((await fetch(`${base}/api/cases/${caseId}`, { headers: { Cookie: cookie(admin.id, "ADMIN") } })).status).toBe(200);
    expect(await prisma.event.count({ where: { caseId, type: "ACCESS_STAFF_GRANTED", actorId: admin.id } })).toBe(1);
  });

  it("serves localized titles, script nonces, security headers and graceful malformed URLs", async () => {
    for (const locale of ["fr-CA", "en-CA"]) {
      const page = await fetch(`${base}/${locale}/auth/sign-in`);
      expect(page.status).toBe(200);
      expect(page.headers.get("x-powered-by")).toBeNull();
      expect(page.headers.get("x-frame-options")).toBe("DENY");
      expect(page.headers.get("x-content-type-options")).toBe("nosniff");
      expect(page.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
      const csp = page.headers.get("content-security-policy")!;
      const nonce = csp.match(/'nonce-([^']+)'/)![1];
      const html = await page.text();
      expect(html).toContain(`lang="${locale}"`); expect(html).toContain(`nonce="${nonce}"`);
      expect(html).toContain(locale === "fr-CA" ? "Se connecter · Aequitas" : "Sign in · Aequitas");
    }
    expect((await fetch(base + "/fr-CA/%")).status).toBe(400);
    expect((await fetch(base + "/fr-CA/invite/%25")).status).toBe(400);
    expect((await fetch(base + "/api/health")).status).toBe(200);
  });

  it("clears sign-in cookies and preserves locale when signing out", async () => {
    const result = await fetch(base + "/api/auth/sign-out", { method: "POST", headers: { Cookie: cookie(user.id, "COMPLAINANT"), "Content-Type": "application/x-www-form-urlencoded", Origin: base }, body: "locale=en-CA", redirect: "manual" });
    expect(result.status).toBe(303); expect(result.headers.get("location")).toBe("/en-CA/auth/sign-in");
    expect(result.headers.getSetCookie().some(value => value.startsWith(`${SESSION_COOKIE}=`) && value.includes("1970"))).toBe(true);
  });
});
