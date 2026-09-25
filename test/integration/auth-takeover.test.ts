import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../src/lib/prisma";
import { signPayload } from "../../src/lib/signedCookie";
import { SESSION_COOKIE } from "../../src/lib/session";
import { CHALLENGE_COOKIE, CHALLENGE_TTL_SECONDS, ORIGIN, RP_ID } from "../../src/lib/webauthn";
import { CookieJar, startNextDev, type DevServer } from "../helpers/nextDevServer";
import { createRegistrationResponse } from "../helpers/softAuthenticator";

/**
 * C1 (account takeover by passkey registration) and H1 (self-registration as
 * CASE_MANAGER), plus the invite-claim path that replaces "register with the
 * same email" for pre-created accounts. Real HTTP against `next dev`, real
 * (software-authenticator) WebAuthn ceremonies.
 */

const PORT = 3423;
let server: DevServer;
let base: string;

function sessionCookie(userId: string, globalRole: string): string {
  return `${SESSION_COOKIE}=${signPayload({ userId, globalRole, authMethod: "passkey" }, 60 * 60)}`;
}

function post(path: string, body: unknown, cookie?: string) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
}

async function fakeCredential(userId: string) {
  await prisma.webAuthnCredential.create({
    data: { userId, credentialId: randomBytes(16).toString("base64url"), publicKey: randomBytes(65), counter: BigInt(0), transports: [] },
  });
}

let victim: { id: string; email: string };
let placeholder: { id: string; email: string };
let otherUser: { id: string; email: string };
let admin: { id: string; email: string };

beforeAll(async () => {
  server = await startNextDev(PORT);
  base = server.baseUrl;
  [victim, placeholder, otherUser, admin] = await Promise.all([
    prisma.user.create({ data: { email: `c1-victim-${randomUUID()}@example.com`, displayName: "Victim", globalRole: "COMPLAINANT" } }),
    prisma.user.create({ data: { email: `c1-placeholder-${randomUUID()}@example.com`, displayName: "Placeholder", globalRole: "RESPONDENT" } }),
    prisma.user.create({ data: { email: `c1-other-${randomUUID()}@example.com`, displayName: "Other", globalRole: "COMPLAINANT" } }),
    prisma.user.create({ data: { email: `c1-admin-${randomUUID()}@example.com`, displayName: "Admin", globalRole: "ADMIN" } }),
  ]);
  await fakeCredential(victim.id);
}, 240_000);

afterAll(async () => {
  await server?.stop();
  await prisma.$disconnect();
});

describe("C1: passkey registration never attaches to an existing account by email alone", () => {
  it("options for an email that already has a passkey: 403 without a session", async () => {
    const res = await post("/api/auth/webauthn/register", { step: "options", email: victim.email, displayName: "Attacker", globalRole: "COMPLAINANT" });
    expect(res.status).toBe(403);
  });

  it("options for a placeholder account (no passkey yet): 403 without a session; placeholders are claimed by invite", async () => {
    const res = await post("/api/auth/webauthn/register", { step: "options", email: placeholder.email, displayName: "Attacker", globalRole: "RESPONDENT" });
    expect(res.status).toBe(403);
  });

  it("options for someone else's email while signed in as a different user: 403", async () => {
    const res = await post(
      "/api/auth/webauthn/register",
      { step: "options", email: victim.email, displayName: "Attacker", globalRole: "COMPLAINANT" },
      sessionCookie(otherUser.id, "COMPLAINANT")
    );
    expect(res.status).toBe(403);
  });

  it("verify with a valid attestation for an existing email and no session: 403, and no credential is attached", async () => {
    const before = await prisma.webAuthnCredential.count({ where: { userId: victim.id } });
    const challenge = randomBytes(32).toString("base64url");
    const challengeCookie = signPayload(
      { challenge, email: victim.email, displayName: "Attacker", globalRole: "COMPLAINANT" },
      CHALLENGE_TTL_SECONDS
    );
    const response = createRegistrationResponse({ challenge }, ORIGIN, RP_ID);
    const res = await post("/api/auth/webauthn/register", { step: "verify", response }, `${CHALLENGE_COOKIE}=${challengeCookie}`);
    expect(res.status).toBe(403);
    expect(res.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`) && !/max-age=0/i.test(c))).toBe(false);
    const after = await prisma.webAuthnCredential.count({ where: { userId: victim.id } });
    expect(after).toBe(before);
  });

  it("a signed-in user may add another passkey to their own account", async () => {
    const jar = new CookieJar();
    const cookie = sessionCookie(victim.id, "COMPLAINANT");
    const opt = await post("/api/auth/webauthn/register", { step: "options", email: victim.email, displayName: "Victim", globalRole: "COMPLAINANT" }, cookie);
    expect(opt.status).toBe(200);
    jar.absorb(opt);
    const options = await opt.json();
    const response = createRegistrationResponse(options, ORIGIN, RP_ID);
    const before = await prisma.webAuthnCredential.count({ where: { userId: victim.id } });
    const ver = await post("/api/auth/webauthn/register", { step: "verify", response }, `${cookie}; ${CHALLENGE_COOKIE}=${jar.get(CHALLENGE_COOKIE)}`);
    expect(ver.status).toBe(200);
    expect(await prisma.webAuthnCredential.count({ where: { userId: victim.id } })).toBe(before + 1);
  });

  it("a brand-new email can still self-register as a complainant, end to end", async () => {
    const email = `c1-new-${randomUUID()}@example.com`;
    const jar = new CookieJar();
    const opt = await post("/api/auth/webauthn/register", { step: "options", email, displayName: "New Person", globalRole: "COMPLAINANT" });
    expect(opt.status).toBe(200);
    jar.absorb(opt);
    const response = createRegistrationResponse(await opt.json(), ORIGIN, RP_ID);
    const ver = await post("/api/auth/webauthn/register", { step: "verify", response }, jar.header());
    expect(ver.status).toBe(200);
    const user = await prisma.user.findUniqueOrThrow({ where: { email }, include: { credentials: true } });
    expect(user.globalRole).toBe("COMPLAINANT");
    expect(user.credentials).toHaveLength(1);
  });
});

describe("H1: CASE_MANAGER is not self-registerable", () => {
  it("options with globalRole CASE_MANAGER for a new email: 400", async () => {
    const res = await post("/api/auth/webauthn/register", {
      step: "options",
      email: `h1-${randomUUID()}@example.com`,
      displayName: "Would-be manager",
      globalRole: "CASE_MANAGER",
    });
    expect(res.status).toBe(400);
  });
});

describe("Invite path: admin-issued, single-use claim of a pre-created account", () => {
  it("issuing an invite needs a session (401) and the ADMIN role (403)", async () => {
    const body = { email: `inv-${randomUUID()}@example.com`, displayName: "Manager", globalRole: "CASE_MANAGER" };
    expect((await post("/api/auth/invite", body)).status).toBe(401);
    expect((await post("/api/auth/invite", body, sessionCookie(otherUser.id, "COMPLAINANT"))).status).toBe(403);
  });

  it("an admin provisions a case manager; the invitee claims it once with a passkey; a second claim is refused", async () => {
    const email = `inv-mgr-${randomUUID()}@example.com`;
    const issued = await post("/api/auth/invite", { email, displayName: "Invited Manager", globalRole: "CASE_MANAGER", locale: "fr-CA" }, sessionCookie(admin.id, "ADMIN"));
    expect(issued.status).toBe(200);
    const { claimPath, userId } = await issued.json();
    expect(claimPath).toMatch(/^\/fr-CA\/invite\/[^/]+$/);
    const token = decodeURIComponent(claimPath.split("/").pop());
    const invitee = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(invitee.email).toBe(email);
    expect(invitee.globalRole).toBe("CASE_MANAGER");

    const jar = new CookieJar();
    const opt = await post("/api/auth/invite/claim", { step: "options", token });
    expect(opt.status).toBe(200);
    jar.absorb(opt);
    const response = createRegistrationResponse(await opt.json(), ORIGIN, RP_ID);
    const ver = await post("/api/auth/invite/claim", { step: "verify", token, response }, jar.header());
    expect(ver.status).toBe(200);
    jar.absorb(ver);
    expect(jar.get(SESSION_COOKIE)).toBeTruthy();
    expect((await ver.json()).id).toBe(userId);
    expect(await prisma.webAuthnCredential.count({ where: { userId } })).toBe(1);

    // Single use: the account now has a passkey, so the same token is dead.
    const again = await post("/api/auth/invite/claim", { step: "options", token });
    expect(again.status).toBe(409);
  });

  it("a placeholder respondent is claimed through an invite, never through plain registration", async () => {
    const issued = await post("/api/auth/invite", { email: placeholder.email, displayName: "Placeholder", globalRole: "RESPONDENT" }, sessionCookie(admin.id, "ADMIN"));
    expect(issued.status).toBe(200);
    const { claimPath, userId } = await issued.json();
    expect(userId).toBe(placeholder.id);
    const token = decodeURIComponent(claimPath.split("/").pop());
    const jar = new CookieJar();
    const opt = await post("/api/auth/invite/claim", { step: "options", token });
    expect(opt.status).toBe(200);
    jar.absorb(opt);
    const response = createRegistrationResponse(await opt.json(), ORIGIN, RP_ID);
    const ver = await post("/api/auth/invite/claim", { step: "verify", token, response }, jar.header());
    expect(ver.status).toBe(200);
  });

  it("no invite for an account that already has a passkey (409), and a tampered token is rejected (400)", async () => {
    const res = await post("/api/auth/invite", { email: victim.email, displayName: "Victim", globalRole: "COMPLAINANT" }, sessionCookie(admin.id, "ADMIN"));
    expect(res.status).toBe(409);
    const bad = await post("/api/auth/invite/claim", { step: "options", token: "not-a-real-token.signature" });
    expect(bad.status).toBe(400);
  });

  it("ADMIN cannot be provisioned through an invite", async () => {
    const res = await post("/api/auth/invite", { email: `inv-admin-${randomUUID()}@example.com`, displayName: "X", globalRole: "ADMIN" }, sessionCookie(admin.id, "ADMIN"));
    expect(res.status).toBe(400);
  });
});
