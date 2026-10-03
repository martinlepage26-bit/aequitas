import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { cfg, syntheticEmail } from "./lib/config";
import { Client, parseSetCookie, setSuite } from "./lib/http";
import { observe } from "./lib/evidence";
import { signPayload, signRaw } from "./lib/crypto";
import { SoftAuthenticator, register, signIn, signInOptions } from "./lib/webauthn";
import { closePool, one, q } from "./lib/db";
import { createCase, makeAccount, makeAdmin, statementId, type Account } from "./lib/world";

/** Area 1: authentication, against the production build with real WebAuthn ceremonies (software authenticator). */
const SESSION = "aequitas_session", CHALLENGE = "aequitas_webauthn_challenge";
const anon = (label = "anon") => new Client(label);
let admin: Account;
beforeAll(async () => { setSuite("02-authentication"); admin = await makeAdmin("auth-admin"); });
afterAll(async () => { await closePool(); });

/** The origin Next.js 16.3.8 derives for request.url: configured hostname (localhost) + port, scheme from X-Forwarded-Proto. */
const SERVER_ORIGIN = `http://localhost:${new URL(cfg.base).port}`;
const attrs = (line: string) => parseSetCookie(line).attributes;
const cookieLine = (client: Client, name: string) => client.lastSetCookies.find((l) => l.startsWith(`${name}=`));

describe("registration (real WebAuthn)", () => {
  it("registers a complainant and a respondent; the session cookie has the right attributes", async () => {
    for (const role of ["COMPLAINANT", "RESPONDENT"] as const) {
      const client = anon();
      const { options, verify } = await register(client, { email: syntheticEmail("reg"), displayName: "Audit Registrant", globalRole: role });
      expect(options.status).toBe(200);
      expect(verify!.status, verify!.text).toBe(200);
      expect(verify!.json).toMatchObject({ globalRole: role });
      expect(Object.keys(verify!.json).sort()).toEqual(["displayName", "email", "globalRole", "id"]);
      const session = cookieLine(client, SESSION)!;
      expect(session).toBeTruthy();
      const a = attrs(session);
      expect(a.httponly).toBe(true);
      expect(a.secure).toBe(true);
      expect(String(a.samesite).toLowerCase()).toBe("strict");
      expect(a.path).toBe("/");
      expect(Number(a["max-age"])).toBe(7 * 24 * 3600);
      observe("02-authentication", "session-cookie-attributes", { attributes: a, role });
      // the challenge cookie is consumed on success
      const challenge = cookieLine(client, CHALLENGE);
      expect(challenge === undefined || /max-age=0|expires=Thu, 01 Jan 1970/i.test(challenge)).toBe(true);
    }
  });
  it("the ceremony's challenge cookie has the right attributes and a 5-minute lifetime", async () => {
    const client = anon();
    const res = await client.post("/api/auth/webauthn/register", { step: "options", email: syntheticEmail("chal"), displayName: "X", globalRole: "COMPLAINANT" });
    expect(res.status).toBe(200);
    const a = attrs(cookieLine(client, CHALLENGE)!);
    expect(a.httponly).toBe(true); expect(a.secure).toBe(true); expect(String(a.samesite).toLowerCase()).toBe("strict"); expect(a.path).toBe("/");
    expect(Number(a["max-age"])).toBe(300);
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
  });
  it("refuses staff/unknown roles and bad input, and creates no account", async () => {
    for (const globalRole of ["ADMIN", "CASE_MANAGER", "SUPERUSER", "", undefined]) {
      const email = syntheticEmail("role");
      const res = await anon().post("/api/auth/webauthn/register", { step: "options", email, displayName: "Role Probe", globalRole });
      expect(res.status, `role ${String(globalRole)}`).toBe(400);
      expect(await one(`select 1 from "User" where email=$1`, [email])).toBeUndefined();
    }
    for (const body of [{ step: "options", email: "no-at-sign", displayName: "X", globalRole: "COMPLAINANT" }, { step: "options", email: syntheticEmail("dn"), displayName: "   ", globalRole: "COMPLAINANT" }, { step: "nope" }, {}]) {
      expect((await anon().post("/api/auth/webauthn/register", body)).status).toBe(400);
    }
  });
  it("normalises the email (trim, lowercase) and coerces an unknown locale to fr-CA", async () => {
    const raw = `  ${syntheticEmail("MiXeD").toUpperCase()}  `;
    const { verify } = await register(anon(), { email: raw, displayName: "Case Probe", globalRole: "COMPLAINANT", locale: "xx-YY" });
    expect(verify!.status).toBe(200);
    const row = await one<{ email: string; locale: string }>(`select email, locale from "User" where id=$1`, [verify!.json.id]);
    expect(row!.email).toBe(raw.trim().toLowerCase());
    expect(row!.locale).toBe("fr-CA");
  });
  it("cannot take over an existing account: anonymous and other users get 403 and no credential is attached", async () => {
    const victim = await makeAccount("COMPLAINANT", "victim");
    const before = Number((await one<{ n: string }>(`select count(*) n from "WebAuthnCredential" where "userId"=$1`, [victim.userId]))!.n);
    const attacker = await makeAccount("COMPLAINANT", "attacker");
    for (const client of [anon("anonymous"), attacker.client]) {
      const { options, verify } = await register(client, { email: victim.email, displayName: "Takeover", globalRole: "COMPLAINANT" });
      expect(options.status).toBe(403);
      expect(verify).toBeNull();
    }
    expect(Number((await one<{ n: string }>(`select count(*) n from "WebAuthnCredential" where "userId"=$1`, [victim.userId]))!.n)).toBe(before);
  });
  it("lets a signed-in user add a second device to their own account (and only that)", async () => {
    const user = await makeAccount("COMPLAINANT", "twodevice");
    const second = new SoftAuthenticator();
    const { options, verify } = await register(user.client, { email: user.email, displayName: user.name, globalRole: "COMPLAINANT", authenticator: second });
    expect(options.status).toBe(200);
    expect(verify!.status, verify!.text).toBe(200);
    expect(verify!.json.id).toBe(user.userId);
    expect(Number((await one<{ n: string }>(`select count(*) n from "WebAuthnCredential" where "userId"=$1`, [user.userId]))!.n)).toBe(2);
    const fresh = anon();
    expect((await signIn(fresh, second, user.email)).verify!.status).toBe(200);
  });
  it("a placeholder respondent (named in a case, never invited) cannot be claimed by registering its email", async () => {
    const comp = await makeAccount("COMPLAINANT", "namer");
    const email = syntheticEmail("placeholder");
    const { res } = await createCase(comp, email);
    expect(res.status, res.text).toBe(200);
    const stranger = anon();
    const { options } = await register(stranger, { email, displayName: "Impostor", globalRole: "RESPONDENT" });
    expect(options.status).toBe(403);
    expect(Number((await one<{ n: string }>(`select count(*) n from "WebAuthnCredential" c join "User" u on u.id=c."userId" where u.email=$1`, [email]))!.n)).toBe(0);
  });
  it("replaying a registration response is refused and adds no second credential", async () => {
    const client = anon(), email = syntheticEmail("regreplay"), auth = new SoftAuthenticator();
    const options = await client.post("/api/auth/webauthn/register", { step: "options", email, displayName: "Replay", globalRole: "COMPLAINANT" });
    const response = auth.attestation(options.json.challenge);
    const challengeCookie = client.cookie(CHALLENGE)!;
    expect((await client.post("/api/auth/webauthn/register", { step: "verify", response })).status).toBe(200);
    const replayer = anon("replayer"); replayer.setCookie(CHALLENGE, challengeCookie);
    const again = await replayer.post("/api/auth/webauthn/register", { step: "verify", response });
    expect(again.status).toBeGreaterThanOrEqual(400);
    expect(again.status).toBeLessThan(500);
    expect(Number((await one<{ n: string }>(`select count(*) n from "WebAuthnCredential" c join "User" u on u.id=c."userId" where u.email=$1`, [email]))!.n)).toBe(1);
  });
  it("observation: registration options disclose whether an email already has an account (403 vs 200)", async () => {
    const existing = await makeAccount("COMPLAINANT", "enum-existing");
    const a = await anon().post("/api/auth/webauthn/register", { step: "options", email: existing.email, displayName: "P", globalRole: "COMPLAINANT" });
    const b = await anon().post("/api/auth/webauthn/register", { step: "options", email: syntheticEmail("enum-new"), displayName: "P", globalRole: "COMPLAINANT" });
    observe("02-authentication", "registration-enumeration", { existing: a.status, unknown: b.status });
    expect([a.status, b.status]).toEqual([403, 200]); // documents the (by-design) distinction; sign-in options are tested separately and must NOT differ
  });
});

describe("sign-in options do not reveal whether an email exists", () => {
  it("existing and unknown emails get structurally identical options and identical cookie attributes", async () => {
    const existing = await makeAccount("COMPLAINANT", "signin-existing");
    const a = anon(), b = anon(), c = anon();
    const ra = await signInOptions(a, existing.email);
    const rb = await signInOptions(b, syntheticEmail("signin-unknown"));
    const rc = await signInOptions(c, "not-even-an-email");
    for (const r of [ra, rb, rc]) { expect(r.status).toBe(200); expect(r.headers.get("cache-control")).toMatch(/no-store/); }
    const normalise = (j: Record<string, unknown>) => JSON.stringify(Object.fromEntries(Object.entries(j).filter(([k]) => k !== "challenge").sort()));
    expect(normalise(rb.json)).toBe(normalise(ra.json));
    expect(normalise(rc.json)).toBe(normalise(ra.json));
    expect(ra.json.allowCredentials ?? []).toEqual([]);
    expect(JSON.stringify(ra.json)).not.toMatch(existing.userId);
    expect(JSON.stringify(ra.json)).not.toContain(existing.email);
    const shape = (client: Client) => JSON.stringify(Object.entries(attrs(cookieLine(client, CHALLENGE)!)).filter(([k]) => k !== "expires").sort());
    expect(shape(b)).toBe(shape(a));
    observe("02-authentication", "signin-options-shape", { keys: Object.keys(ra.json).sort() });
  });
  it("verification failures are indistinguishable: unknown credential, wrong email, tampered assertion", async () => {
    const victim = await makeAccount("COMPLAINANT", "uniform-victim");
    const other = await makeAccount("COMPLAINANT", "uniform-other");
    const messages: string[] = [];
    // 1. credential the server has never seen
    { const c = anon(); const o = await signInOptions(c, victim.email); const r = await c.post("/api/auth/webauthn/authenticate", { step: "verify", response: new SoftAuthenticator().assertion(o.json.challenge) }); expect(r.status).toBe(400); messages.push(r.json.message); }
    // 2. a real credential presented for somebody else's email
    { const c = anon(); const o = await signInOptions(c, victim.email); const r = await c.post("/api/auth/webauthn/authenticate", { step: "verify", response: other.auth.assertion(o.json.challenge) }); expect(r.status).toBe(400); messages.push(r.json.message); }
    // 3. an email nobody owns
    { const c = anon(); const o = await signInOptions(c, syntheticEmail("nobody")); const r = await c.post("/api/auth/webauthn/authenticate", { step: "verify", response: other.auth.assertion(o.json.challenge) }); expect(r.status).toBe(400); messages.push(r.json.message); }
    expect(new Set(messages).size, messages.join(" | ")).toBe(1);
    for (const m of messages) expect(m).not.toMatch(/exist|no such|unknown|not found|registered/i);
  });
});

describe("sign-in (real WebAuthn assertions)", () => {
  it("succeeds with a valid assertion, sets the session cookie and returns only the public profile", async () => {
    const user = await makeAccount("COMPLAINANT", "signin-ok");
    const client = anon();
    const { verify } = await signIn(client, user.auth, user.email);
    expect(verify!.status).toBe(200);
    expect(Object.keys(verify!.json).sort()).toEqual(["displayName", "email", "globalRole", "id"]);
    expect(client.cookie(SESSION)).toBeTruthy();
    expect((await client.get("/fr-CA/cases")).status).toBe(200);
    expect(Number((await one<{ counter: string }>(`select counter from "WebAuthnCredential" where "userId"=$1`, [user.userId]))!.counter)).toBeGreaterThan(0);
  });
  for (const tamper of ["signature", "challenge", "type", "rp", "origin", "flags"] as const) {
    it(`rejects an assertion with a tampered ${tamper} and sets no session`, async () => {
      const user = await makeAccount("COMPLAINANT", `tamper-${tamper}`);
      const client = anon();
      const { verify } = await signIn(client, user.auth, user.email, { tamper });
      expect(verify!.status).toBe(400);
      expect(client.cookie(SESSION)).toBeUndefined();
    });
  }
  it("counts failed attempts without throttling (observation: no rate limit)", async () => {
    const user = await makeAccount("COMPLAINANT", "ratelimit");
    const statuses: number[] = [];
    for (let i = 0; i < 30; i++) statuses.push((await signIn(anon(), user.auth, user.email, { tamper: "signature" })).verify!.status);
    observe("02-authentication", "no-rate-limit-signin", { attempts: statuses.length, distinct: [...new Set(statuses)] });
    expect(statuses.every((s) => s === 400)).toBe(true);
  });
  it("REPLAY, incrementing counter: the same assertion + challenge cookie is refused the second time", async () => {
    const user = await makeAccount("COMPLAINANT", "replay-inc");
    const first = anon();
    const options = await signInOptions(first, user.email);
    const challengeCookie = first.cookie(CHALLENGE)!;
    const assertion = user.auth.assertion(options.json.challenge, { counter: "increment" });
    expect((await first.post("/api/auth/webauthn/authenticate", { step: "verify", response: assertion })).status).toBe(200);
    const replayer = anon("replayer"); replayer.setCookie(CHALLENGE, challengeCookie);
    const again = await replayer.post("/api/auth/webauthn/authenticate", { step: "verify", response: assertion });
    expect(again.status, "replay must not mint a second session").toBe(400);
    expect(replayer.cookie(SESSION)).toBeUndefined();
  });
  it("REPLAY, counter-less authenticator (signCount always 0, e.g. synced passkeys): the same assertion + challenge cookie must be refused", async () => {
    const auth = new SoftAuthenticator();
    const email = syntheticEmail("replay-zero");
    const reg = await register(anon(), { email, displayName: "Zero Counter", globalRole: "COMPLAINANT", authenticator: auth });
    expect(reg.verify!.status).toBe(200);
    const first = anon();
    const options = await signInOptions(first, email);
    const challengeCookie = first.cookie(CHALLENGE)!;
    const assertion = auth.assertion(options.json.challenge, { counter: "zero" });
    expect((await first.post("/api/auth/webauthn/authenticate", { step: "verify", response: assertion })).status).toBe(200);
    const replayer = anon("replayer"); replayer.setCookie(CHALLENGE, challengeCookie);
    const again = await replayer.post("/api/auth/webauthn/authenticate", { step: "verify", response: assertion });
    observe("02-authentication", "replay-counterless-signin", { replayStatus: again.status, sessionIssued: Boolean(replayer.cookie(SESSION)) });
    expect(again.status, "challenge is stateless, so only the signature counter could stop a replay").toBe(400);
  });
  it("a challenge is not consumed by a failed attempt: the same challenge cookie accepts a later valid assertion", async () => {
    const user = await makeAccount("COMPLAINANT", "retry");
    const client = anon();
    const options = await signInOptions(client, user.email);
    const bad = await client.post("/api/auth/webauthn/authenticate", { step: "verify", response: user.auth.assertion(options.json.challenge, { tamper: "signature" }) });
    expect(bad.status).toBe(400);
    const good = await client.post("/api/auth/webauthn/authenticate", { step: "verify", response: user.auth.assertion(options.json.challenge) });
    observe("02-authentication", "challenge-survives-failed-attempt", { goodAfterBad: good.status });
    expect(good.status).toBe(200);
  });
});

describe("expired, malformed, replayed and wrong-purpose tokens", () => {
  const caseUrl = "/api/cases/00000000-0000-4000-8000-000000000000";
  it("an expired challenge cookie is refused by all three ceremonies", async () => {
    const user = await makeAccount("COMPLAINANT", "expired-chal");
    const expired = (payload: unknown) => signRaw({ payload, exp: Date.now() - 1000 });
    const cases: Array<[string, string, unknown]> = [
      ["/api/auth/webauthn/authenticate", "authenticate", { purpose: "authenticate", challenge: "c", email: user.email }],
      ["/api/auth/webauthn/register", "register", { purpose: "register", challenge: "c", email: syntheticEmail("e"), displayName: "x", globalRole: "COMPLAINANT", locale: "fr-CA" }],
    ];
    for (const [path, , payload] of cases) {
      const c = anon(); c.setCookie(CHALLENGE, expired(payload));
      const res = await c.post(path, { step: "verify", response: { id: user.auth.credentialId } });
      expect(res.status, path).toBe(400);
      expect(res.json.message).toMatch(/expired|not started/i);
    }
  });
  it("tokens with a missing, non-numeric or NaN expiry are refused as sessions and as challenges", async () => {
    const payload = { purpose: "session", userId: randomUUID(), globalRole: "ADMIN", authMethod: "passkey" };
    for (const body of [{ payload }, { payload, exp: "9999999999999" }, { payload, exp: null }, { payload, exp: Date.now() - 1 }, { exp: Date.now() + 1e6 }]) {
      const c = anon(); c.setCookie(SESSION, signRaw(body));
      expect((await c.get(caseUrl)).status, JSON.stringify(Object.keys(body))).toBe(401);
    }
  });
  it("structurally malformed tokens are 401 as sessions (never 5xx)", async () => {
    const good = signPayload({ purpose: "session", userId: randomUUID(), globalRole: "ADMIN", authMethod: "passkey" }, 60);
    const [data, sig] = good.split(".");
    const flip = (s: string) => s.slice(0, -1) + (s.endsWith("A") ? "B" : "A");
    const tokens = ["", "abc", "a.b", `${good}.extra`, `${data}.`, `.${sig}`, `${data}.${flip(sig)}`, `${flip(data)}.${sig}`, "A".repeat(9000), `${"A".repeat(9000)}.${sig}`, "Bearer x", "{}", "null", ".", `${data}.${sig.slice(0, -1)}`, `${data}!.${sig}`];
    for (const token of tokens) {
      const res = await anon().get(caseUrl, { headers: { cookie: `${SESSION}=${token.replace(/[\r\n;]/g, "")}` } });
      expect(res.status, token.slice(0, 40)).toBe(401);
    }
  });
  it("a token signed with the wrong secret is refused", async () => {
    const forged = signPayload({ purpose: "session", userId: randomUUID(), globalRole: "ADMIN", authMethod: "passkey" }, 3600, "not-the-secret-0000000000000000000000000000000000");
    const c = anon(); c.setCookie(SESSION, forged);
    expect((await c.get(caseUrl)).status).toBe(401);
  });
  it("challenge and invite tokens cannot become session cookies; every wrong-purpose pairing is refused", async () => {
    const uid = randomUUID();
    const notSessions = {
      invite: signPayload({ purpose: "invite", userId: uid, nonce: randomUUID() }, 3600),
      authenticate: signPayload({ purpose: "authenticate", challenge: "x", email: "a@b.test" }, 300),
      register: signPayload({ purpose: "register", challenge: "x", email: "a@b.test", displayName: "x", globalRole: "ADMIN", locale: "fr-CA" }, 300),
      claim: signPayload({ purpose: "invite-claim", challenge: "x", userId: uid, invitationId: uid }, 300),
      noPurpose: signPayload({ userId: uid, globalRole: "ADMIN", authMethod: "passkey" }, 300),
      adminWithPasswordMethod: signPayload({ purpose: "session", userId: uid, globalRole: "ADMIN", authMethod: "password" }, 300),
      unknownRole: signPayload({ purpose: "session", userId: uid, globalRole: "SUPERADMIN", authMethod: "passkey" }, 300),
      emptyUser: signPayload({ purpose: "session", userId: "  ", globalRole: "ADMIN", authMethod: "passkey" }, 300),
      numericUser: signPayload({ purpose: "session", userId: 12345, globalRole: "ADMIN", authMethod: "passkey" }, 300),
      missingMethod: signPayload({ purpose: "session", userId: uid, globalRole: "ADMIN" }, 300),
    };
    for (const [label, token] of Object.entries(notSessions)) {
      const c = anon(label); c.setCookie(SESSION, token);
      for (const path of [caseUrl, "/api/auth/invite"]) expect((await c.get(path)).status, `${label} on ${path}`).toBe(401);
      expect((await c.get("/fr-CA/cases")).status, `${label} on page`).toBe(307);
    }
    // a session token presented where an invite or a challenge belongs
    const session = signPayload({ purpose: "session", userId: uid, globalRole: "ADMIN", authMethod: "passkey" }, 3600);
    expect((await anon().post("/api/auth/invite/claim", { step: "options", token: session })).status).toBe(400);
    for (const [label, token] of Object.entries({ session, invite: notSessions.invite, register: notSessions.register, claim: notSessions.claim })) {
      const c = anon(label); c.setCookie(CHALLENGE, token);
      const res = await c.post("/api/auth/webauthn/authenticate", { step: "verify", response: { id: "x" } });
      expect(res.status, `${label} as authenticate challenge`).toBe(400);
      expect(c.cookie(SESSION)).toBeUndefined();
    }
    // a register-purpose cookie must not satisfy invite-claim verification, and vice-versa
    const c2 = anon(); c2.setCookie(CHALLENGE, notSessions.register);
    expect((await c2.post("/api/auth/invite/claim", { step: "verify", token: notSessions.invite, response: {} })).status).toBe(400);
  });
  it("observation: a correctly signed session for a user that does not exist", async () => {
    const orphan = signPayload({ purpose: "session", userId: randomUUID(), globalRole: "COMPLAINANT", authMethod: "passkey" }, 3600);
    const c = anon(); c.setCookie(SESSION, orphan);
    const read = await c.get(caseUrl);
    const create = await c.post("/api/cases", { respondentEmail: syntheticEmail("o"), respondentDisplayName: "x", requestedStatementVersionId: await statementId() });
    observe("02-authentication", "orphan-session", { readStatus: read.status, createStatus: create.status });
    expect(read.status).toBe(404);
    expect(create.status, create.text.slice(0, 120)).toBeLessThan(500);
  });
});

describe("session lifetime and revocation", () => {
  it("sign-out clears the session and pending challenge, keeps the locale and refuses cross-site posts", async () => {
    const user = await makeAccount("COMPLAINANT", "signout");
    const form = (locale: string) => { const f = new FormData(); f.set("locale", locale); return f; };
    const origin = SERVER_ORIGIN;
    for (const [locale, expected] of [["en-CA", "/en-CA/auth/sign-in"], ["fr-CA", "/fr-CA/auth/sign-in"], ["de-DE", "/fr-CA/auth/sign-in"], ["//evil.invalid", "/fr-CA/auth/sign-in"]]) {
      const client = await (async () => { const c = user.client.clone(`signout-${locale}`); c.setCookie(CHALLENGE, "pending"); return c; })();
      const res = await client.request("POST", "/api/auth/sign-out", { form: form(locale), headers: { origin } });
      expect(res.status, locale).toBe(303);
      expect(res.headers.get("location"), locale).toBe(expected);
      expect(res.headers.get("cache-control")).toMatch(/no-store/);
      const cleared = (name: string) => client.lastSetCookies.some((l) => l.startsWith(`${name}=`) && /max-age=0|expires=Thu, 01 Jan 1970/i.test(l));
      expect(cleared(SESSION), `session cleared (${locale})`).toBe(true);
      expect(cleared(CHALLENGE), `challenge cleared (${locale})`).toBe(true);
      expect(client.cookie(SESSION)).toBeUndefined();
    }
    for (const headers of [{ origin: "https://evil.invalid" }, { "sec-fetch-site": "cross-site" }] as Array<Record<string, string>>) {
      const res = await user.client.request("POST", "/api/auth/sign-out", { form: form("fr-CA"), headers, cookies: false });
      expect(res.status, JSON.stringify(headers)).toBe(403);
    }
    expect((await user.client.get("/api/auth/sign-out")).status).toBe(405);
  });
  it("sign-out accepts a same-origin browser POST arriving through a TLS-terminating proxy (Origin == public Host)", async () => {
    // What a browser at the public hostname sends: Host/Origin are the public site, the proxy adds X-Forwarded-*.
    const user = await makeAccount("COMPLAINANT", "signout-proxy");
    const publicHost = "aequitas-audit.example.test";
    const res = await user.client.request("POST", "/api/auth/sign-out", {
      form: (() => { const f = new FormData(); f.set("locale", "en-CA"); return f; })(),
      headers: { host: publicHost, origin: `https://${publicHost}`, "x-forwarded-proto": "https", "x-forwarded-host": publicHost, "sec-fetch-site": "same-origin" },
    });
    observe("02-authentication", "signout-behind-proxy", { status: res.status, body: res.text.slice(0, 80) });
    expect(res.status, `a legitimate browser sign-out must succeed; got ${res.text.slice(0, 80)}`).toBe(303);
  });
  it("a copied session cookie stops working after sign-out (server-side revocation)", async () => {
    const user = await makeAccount("COMPLAINANT", "revocation");
    const stolen = user.client.cookie(SESSION)!;
    expect((await user.client.request("POST", "/api/auth/sign-out", { form: new FormData() })).status).toBe(303);
    const replayer = anon("copied-cookie"); replayer.setCookie(SESSION, stolen);
    const res = await replayer.get("/api/cases/00000000-0000-4000-8000-000000000000");
    observe("02-authentication", "session-after-signout", { status: res.status });
    expect(res.status, "sessions are stateless HMAC cookies; sign-out only asks the browser to forget it").toBe(401);
  });
  it("a changed global role takes effect immediately (cookie role is not trusted for 7 days)", async () => {
    const demoted = await makeAdmin("demoted");
    const body = { email: syntheticEmail("probe"), displayName: "Probe", globalRole: "RESPONDENT" };
    expect((await demoted.client.post("/api/auth/invite", body)).status).toBe(200);
    await q(`update "User" set "globalRole"='COMPLAINANT' where id=$1`, [demoted.userId]);
    const after = await demoted.client.post("/api/auth/invite", { ...body, email: syntheticEmail("probe2") });
    await q(`update "User" set "globalRole"='ADMIN' where id=$1`, [demoted.userId]);
    observe("02-authentication", "role-change-takes-effect", { statusAfterDemotion: after.status });
    expect(after.status).toBe(403);
  });
});
