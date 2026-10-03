import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { cfg, sleep, syntheticEmail } from "./lib/config";
import { Client, setSuite } from "./lib/http";
import { observe } from "./lib/evidence";
import { signPayload } from "./lib/crypto";
import { SoftAuthenticator, claimInvite, tokenFromClaimPath } from "./lib/webauthn";
import { assertAuditDatabase, closePool, one, q } from "./lib/db";
import { createCase, driveCase, freshSession, makeAccount, makeAdmin, makeManager, ok, type Account } from "./lib/world";
import { stub } from "./lib/stub";

/**
 * Area 2: invitations and email. Resend is MOCKED (audit stub); nothing is ever sent to a real recipient.
 * The server under test runs with the mail configuration enabled, so the real mail.ts code builds real requests.
 */
let admin: Account, comp: Account, resp: Account, cm: Account;
beforeAll(async () => { setSuite("03-invitations-email"); admin = await makeAdmin("inv-admin"); comp = await makeAccount("COMPLAINANT", "inv-comp"); resp = await makeAccount("RESPONDENT", "inv-resp"); cm = await makeManager(admin, "inv-cm"); });
afterAll(async () => { await closePool(); });
beforeEach(async () => {
  await stub.reset();
  // Isolation: undeliverable notifications left by an earlier test would otherwise occupy the outbox's 20-slot window.
  await assertAuditDatabase();
  await q(`update "Notification" set "sentAt"=now() where "sentAt" is null`);
});

const invite = (body: Record<string, unknown>, who: Account = admin) => who.client.post("/api/auth/invite", body);
const newInvitee = (role = "RESPONDENT", extra: Record<string, unknown> = {}) => { const email = syntheticEmail(`invitee-${role.toLowerCase()}`); return { email, body: { email, displayName: `Audit ${role} invitee`, globalRole: role, locale: "fr-CA", ...extra } }; };
const invRow = (id: string) => one<Record<string, any>>(`select * from "Invitation" where id=$1`, [id]);
const credCount = async (userId: string) => Number((await one<{ n: string }>(`select count(*) n from "WebAuthnCredential" where "userId"=$1`, [userId]))!.n);

describe("issuing, listing and revoking is administrator-only", () => {
  it("anonymous callers get 401 and non-admin roles get 403 on every invitation operation", async () => {
    const { body } = newInvitee();
    for (const who of [new Client("anon"), comp.client, resp.client, cm.client]) {
      const expected = who.label === "anon" ? 401 : 403;
      expect((await who.post("/api/auth/invite", body)).status, `${who.label} POST`).toBe(expected);
      expect((await who.get("/api/auth/invite")).status, `${who.label} GET`).toBe(expected);
      expect((await who.del("/api/auth/invite", { invitationId: randomUUID() })).status, `${who.label} DELETE`).toBe(expected);
      expect((await who.request("PATCH", "/api/auth/invite")).status, `${who.label} PATCH`).toBe(expected);
    }
    expect(await one(`select 1 from "User" where email=$1`, [body.email])).toBeUndefined(); // refused callers created nothing
  });
  it("an administrator issues a single-use link that expires in 72 hours, and the list shows it", async () => {
    const { email, body } = newInvitee("COMPLAINANT");
    const res = await invite(body);
    expect(res.status).toBe(200);
    expect(Object.keys(res.json).sort()).toEqual(["claimPath", "delivery", "expiresAt", "invitationId", "userId"]);
    expect(res.json.delivery).toBe("manual");
    expect(res.json.claimPath).toMatch(/^\/fr-CA\/invite\/[^/]+$/);
    const hours = (Date.parse(res.json.expiresAt) - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(71.9); expect(hours).toBeLessThan(72.1);
    const row = await invRow(res.json.invitationId);
    expect(row!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(tokenFromClaimPath(res.json.claimPath)); // only the hash is stored
    const list = await admin.client.get("/api/auth/invite");
    expect(list.json.emailConfigured).toBe(true);
    expect(list.json.invitations.some((i: { id: string; user: { email: string } }) => i.id === res.json.invitationId && i.user.email === email)).toBe(true);
    expect(JSON.stringify(list.json)).not.toMatch(/tokenHash/);
  });
  it("validates the request: ADMIN is not invitable, roles/locales/emails/names are checked, claimed or mismatched accounts conflict", async () => {
    const base = newInvitee().body;
    expect((await invite({ ...base, globalRole: "ADMIN" })).status).toBe(400);
    expect((await invite({ ...base, globalRole: "SUPERUSER" })).status).toBe(400);
    expect((await invite({ ...base, email: "nobody" })).status).toBe(400);
    expect((await invite({ ...base, locale: "//evil.invalid" })).status).toBe(400);
    expect((await invite({ ...base, locale: "de-DE" })).status).toBe(400);
    expect((await invite({ ...base, displayName: "  " })).status).toBe(400);
    expect((await invite({ ...base, email: comp.email, globalRole: "RESPONDENT" })).status).toBe(409); // different role
    expect((await invite({ ...base, email: resp.email, globalRole: "RESPONDENT" })).status).toBe(409); // already claimed
    expect(await one(`select 1 from "User" where email=$1`, [base.email])).toBeUndefined();
  });
  it("a replacement link revokes the older unused one; revocation is final and idempotent-safe", async () => {
    const { email, body } = newInvitee();
    const first = await invite(body), second = await invite(body);
    expect(first.json.userId).toBe(second.json.userId);
    expect((await invRow(first.json.invitationId))!.revokedAt).not.toBeNull();
    expect((await invRow(second.json.invitationId))!.revokedAt).toBeNull();
    expect((await new Client("c1").post("/api/auth/invite/claim", { step: "options", token: tokenFromClaimPath(first.json.claimPath) })).status).toBe(400);
    expect((await new Client("c2").post("/api/auth/invite/claim", { step: "options", token: tokenFromClaimPath(second.json.claimPath) })).status).toBe(200);
    const revoke = await admin.client.del("/api/auth/invite", { invitationId: second.json.invitationId });
    expect(revoke.status).toBe(200); expect(revoke.json).toEqual({ revoked: true });
    const again = await admin.client.del("/api/auth/invite", { invitationId: second.json.invitationId });
    expect(again.status).toBe(404); expect(again.json).toEqual({ revoked: false });
    expect((await admin.client.del("/api/auth/invite", { invitationId: randomUUID() })).status).toBe(404);
    expect((await admin.client.del("/api/auth/invite", { invitationId: 42 })).status).toBe(400);
    expect((await new Client("c3").post("/api/auth/invite/claim", { step: "options", token: tokenFromClaimPath(second.json.claimPath) })).status).toBe(400);
    expect(await credCount(first.json.userId)).toBe(0);
    expect(email).toBeTruthy();
  });
});

describe("claiming an invitation (real WebAuthn)", () => {
  it("claims once, signs the invitee in with the invited role, and cannot be reused or replayed", async () => {
    const { body } = newInvitee("CASE_MANAGER");
    const issued = await invite(body);
    const token = tokenFromClaimPath(issued.json.claimPath);
    const client = new Client("claimer");
    const { options, verify } = await claimInvite(client, token);
    expect(options.status).toBe(200);
    expect(verify!.status, verify!.text).toBe(200);
    expect(verify!.json).toMatchObject({ globalRole: "CASE_MANAGER", id: issued.json.userId });
    expect((await invRow(issued.json.invitationId))!.claimedAt).not.toBeNull();
    expect(await credCount(issued.json.userId)).toBe(1);
    expect((await client.get("/fr-CA/cases")).status).toBe(200); // staff workspace
    expect((await client.get("/fr-CA/admin/invites")).status).toBe(404); // not an admin
    expect((await client.post("/api/auth/invite", newInvitee().body)).status).toBe(403);
    // second use, in both steps, from a fresh client
    const reuse = new Client("reuse");
    expect((await reuse.post("/api/auth/invite/claim", { step: "options", token })).status).toBe(409);
    const verifyAgain = await reuse.post("/api/auth/invite/claim", { step: "verify", token, response: new SoftAuthenticator().attestation("x") });
    expect(verifyAgain.status).toBe(409);
    expect(await credCount(issued.json.userId)).toBe(1);
    const page = await new Client("page").get(issued.json.claimPath);
    expect(page.status).toBe(200);
    expect(page.text).not.toContain("<form"); // no claim form for a used link
  });
  it("two simultaneous claims of one link: exactly one wins, one credential exists", async () => {
    const { body } = newInvitee();
    const issued = await invite(body);
    const token = tokenFromClaimPath(issued.json.claimPath);
    const [a, b] = [new Client("race-a"), new Client("race-b")];
    const [oa, ob] = await Promise.all([a.post("/api/auth/invite/claim", { step: "options", token }), b.post("/api/auth/invite/claim", { step: "options", token })]);
    expect([oa.status, ob.status]).toEqual([200, 200]);
    const [ra, rb] = await Promise.all([
      a.post("/api/auth/invite/claim", { step: "verify", token, response: new SoftAuthenticator().attestation(oa.json.challenge) }),
      b.post("/api/auth/invite/claim", { step: "verify", token, response: new SoftAuthenticator().attestation(ob.json.challenge) }),
    ]);
    expect([ra.status, rb.status].sort(), `${ra.text} | ${rb.text}`).toEqual([200, 409]);
    expect(await credCount(issued.json.userId)).toBe(1);
  });
  it("revocation after the ceremony has started prevents the claim and attaches no credential", async () => {
    const { body } = newInvitee();
    const issued = await invite(body);
    const token = tokenFromClaimPath(issued.json.claimPath);
    const client = new Client("mid-ceremony");
    const options = await client.post("/api/auth/invite/claim", { step: "options", token });
    expect(options.status).toBe(200);
    expect((await admin.client.del("/api/auth/invite", { invitationId: issued.json.invitationId })).status).toBe(200);
    const verify = await client.post("/api/auth/invite/claim", { step: "verify", token, response: new SoftAuthenticator().attestation(options.json.challenge) });
    expect([400, 409]).toContain(verify.status);
    expect(client.cookie("aequitas_session")).toBeUndefined();
    expect(await credCount(issued.json.userId)).toBe(0);
  });
  it("expiry: a link past its stored expiry, and a token signed with a past expiry, are both refused", async () => {
    const { body } = newInvitee();
    const issued = await invite(body);
    const token = tokenFromClaimPath(issued.json.claimPath);
    await q(`update "Invitation" set "expiresAt" = now() - interval '1 second' where id=$1`, [issued.json.invitationId]);
    expect((await new Client("e1").post("/api/auth/invite/claim", { step: "options", token })).status).toBe(400);
    const page = await new Client("e1p").get(issued.json.claimPath);
    expect(page.status).toBe(200);
    expect(page.text).toContain('role="alert"'); // the styled "invalid or expired" state
    // expiry between options and verify
    const again = await invite({ ...body });
    const t2 = tokenFromClaimPath(again.json.claimPath);
    const c = new Client("e2");
    const options = await c.post("/api/auth/invite/claim", { step: "options", token: t2 });
    await q(`update "Invitation" set "expiresAt" = now() - interval '1 second' where id=$1`, [again.json.invitationId]);
    const verify = await c.post("/api/auth/invite/claim", { step: "verify", token: t2, response: new SoftAuthenticator().attestation(options.json.challenge) });
    expect([400, 409]).toContain(verify.status);
    expect(await credCount(again.json.userId)).toBe(0);
    // a correctly signed token whose own expiry has passed (no DB row needed to be refused)
    const row = await one<{ userId: string }>(`select "userId" from "Invitation" where id=$1`, [again.json.invitationId]);
    const stale = signPayload({ purpose: "invite", userId: row!.userId, nonce: randomUUID() }, -10);
    expect((await new Client("e3").post("/api/auth/invite/claim", { step: "options", token: stale })).status).toBe(400);
  });
  it("a well-signed token with no stored invitation, a wrong-purpose token, and garbage are all refused", async () => {
    const orphan = signPayload({ purpose: "invite", userId: (await one<{ id: string }>(`select id from "User" limit 1`))!.id, nonce: randomUUID() }, 3600);
    const wrong = signPayload({ purpose: "session", userId: comp.userId, globalRole: "COMPLAINANT", authMethod: "passkey" }, 3600);
    for (const token of [orphan, wrong, "garbage", "", null, 42, { a: 1 }]) expect((await new Client("bad").post("/api/auth/invite/claim", { step: "options", token })).status, JSON.stringify(token)?.slice(0, 30)).toBe(400);
  });
  it("the invitation link cannot be used to attach a passkey to a different, already-claimed account", async () => {
    const issued = await invite(newInvitee().body);
    const token = tokenFromClaimPath(issued.json.claimPath);
    // the invited placeholder gets a credential through some other path before the link is used
    await q(`insert into "WebAuthnCredential"(id,"userId","credentialId","publicKey",counter,transports) values ($1,$2,$3,$4,0,'{}')`, [randomUUID(), issued.json.userId, `cred-${randomUUID()}`, Buffer.from("x")]);
    const c = new Client("late");
    expect((await c.post("/api/auth/invite/claim", { step: "options", token })).status).toBe(409);
    expect(await credCount(issued.json.userId)).toBe(1);
  });
  it("concurrent invitations for the same new address do not 500", async () => {
    const { body } = newInvitee();
    const [a, b] = await Promise.all([invite(body), invite(body)]);
    observe("03-invitations-email", "concurrent-invite-same-email", { statuses: [a.status, b.status], bodies: [a.text.slice(0, 80), b.text.slice(0, 80)] });
    expect([a.status, b.status].every((s) => s < 500), `statuses ${a.status}/${b.status}`).toBe(true);
    expect(Number((await one<{ n: string }>(`select count(*) n from "User" where email=$1`, [body.email]))!.n)).toBe(1);
  });
});

describe("a respondent named by a complainant becomes a working account only through an invitation", () => {
  it("lower-case address: invite -> claim -> the respondent can see the case", async () => {
    const email = syntheticEmail("named");
    const { res, caseId } = await createCase(comp, email, { displayName: "Named Respondent" });
    ok(res, "create");
    const issued = await invite({ email, globalRole: "RESPONDENT", locale: "fr-CA" });
    expect(issued.status).toBe(200);
    const client = new Client("named-resp");
    expect((await claimInvite(client, tokenFromClaimPath(issued.json.claimPath))).verify!.status).toBe(200);
    expect((await client.get(`/api/cases/${caseId}`)).status).toBe(200);
  });
  it("naming an EXISTING respondent with different letter case reaches that same account, not a duplicate placeholder", async () => {
    const real = await makeAccount("RESPONDENT", "existing-resp");
    const typed = real.email.toUpperCase().replace("@AUDIT.EXAMPLE.TEST", "@Audit.Example.test");
    const { res, caseId } = await createCase(comp, typed, { displayName: "Typed In Capitals" });
    ok(res, "create");
    const row = await one<{ respondentId: string }>(`select "respondentId" from "Case" where id=$1`, [caseId]);
    const duplicates = await q<{ email: string; credentials: string }>(`select email, (select count(*) from "WebAuthnCredential" c where c."userId"=u.id) credentials from "User" u where lower(email)=$1`, [real.email.toLowerCase()]);
    observe("03-invitations-email", "existing-respondent-different-case", { namedAccountIsTheRealOne: row!.respondentId === real.userId, accountsForOneMailbox: duplicates.length, caseVisibleToRealRespondent: (await real.client.get(`/api/cases/${caseId}`)).status });
    expect(row!.respondentId, "the case must be attached to the respondent who owns this mailbox").toBe(real.userId);
    expect(duplicates.length, "one mailbox must be one account").toBe(1);
  });
  it("a placeholder typed with capital letters can still be invited and then sees its case (addresses are case-insensitive)", async () => {
    const lower = syntheticEmail("mixedcase");
    const typed = lower.replace(/^(.)/, (c) => c.toUpperCase()).replace("audit", "Audit"); // what a human might type
    const { res, caseId } = await createCase(comp, typed, { displayName: "Mixed Case Respondent" });
    ok(res, "create");
    // The administrator invites the address as the complainant wrote it, then in lower case as the sign-in flow normalises it.
    const withoutName = await invite({ email: typed, globalRole: "RESPONDENT", locale: "fr-CA" });
    const issued = withoutName.status === 200 ? withoutName : await invite({ email: typed, displayName: "Mixed Case Respondent", globalRole: "RESPONDENT", locale: "fr-CA" });
    expect(issued.status).toBe(200);
    const client = new Client("mixed-resp");
    expect((await claimInvite(client, tokenFromClaimPath(issued.json.claimPath))).verify!.status).toBe(200);
    const users = await q<{ email: string }>(`select email from "User" where lower(email)=$1`, [lower.toLowerCase()]);
    const read = await client.get(`/api/cases/${caseId}`);
    observe("03-invitations-email", "mixed-case-placeholder", { inviteWithoutNameStatus: withoutName.status, userRowsForOneMailbox: users.length, emails: users.map((u) => u.email), caseReadStatus: read.status });
    expect(users.length, "one mailbox must be one account").toBe(1);
    expect(read.status, "the invited respondent must see the case they were named in").toBe(200);
  });
});

describe("outbound email (Resend mocked): request construction, idempotency, failures", () => {
  it("builds the documented request: From/Reply-To, recipient, subject by locale, link on the app URL, idempotency key", async () => {
    for (const locale of ["fr-CA", "en-CA"]) {
      await stub.reset();
      const { email, body } = newInvitee("RESPONDENT", { locale, sendEmail: true });
      const res = await invite(body);
      expect(res.status).toBe(200);
      expect(res.json.delivery).toBe("accepted");
      const log = await stub.log("resend");
      expect(log).toHaveLength(1);
      const mail = log[0];
      expect(mail.authorizationPresent).toBe(true);
      expect(mail.contentType).toMatch(/application\/json/);
      expect(mail.body.from).toBe("aequitas@pharos-ai.ca");
      expect(mail.body.reply_to).toBe("aequitas@pharos-ai.ca");
      expect(mail.body.to).toEqual([email]);
      expect(mail.body.subject).toBe(locale === "fr-CA" ? "Votre invitation à Aequitas" : "Your invitation to Aequitas");
      expect(mail.body.text).toContain(locale === "fr-CA" ? "72 heures" : "72 hours");
      const link = /https:\/\/[^\s]+/.exec(mail.body.text)![0];
      expect(new URL(link).origin).toBe("https://aequitas-audit.invalid");
      expect(new URL(link).pathname + new URL(link).search).toBe(res.json.claimPath);
      expect(mail.idempotencyKey).toBe(`invitation/${res.json.invitationId}`);
      expect((await invRow(res.json.invitationId))!.emailedAt).not.toBeNull();
      // the emailed link actually works
      expect((await new Client("mail-link").post("/api/auth/invite/claim", { step: "options", token: tokenFromClaimPath(new URL(link).pathname) })).status).toBe(200);
    }
  });
  it("sends nothing unless sendEmail is explicitly true", async () => {
    for (const extra of [{}, { sendEmail: false }, { sendEmail: "true" }, { sendEmail: 1 }]) {
      const res = await invite(newInvitee("RESPONDENT", extra).body);
      expect(res.json.delivery).toBe("manual");
    }
    expect(await stub.log("resend")).toHaveLength(0);
  });
  const failures: Array<[string, Record<string, unknown>]> = [["http500", {}], ["http429", {}], ["http422", {}], ["http401", {}], ["noid", {}], ["notjson", {}], ["drop", {}]];
  for (const [mode, opts] of failures) {
    it(`provider failure (${mode}) is reported as 'failed', nothing is marked emailed, and the link stays usable`, async () => {
      await stub.control("resend", mode, opts);
      const res = await invite(newInvitee("RESPONDENT", { sendEmail: true }).body);
      expect(res.status).toBe(200);
      expect(res.json.delivery).toBe("failed");
      expect((await invRow(res.json.invitationId))!.emailedAt).toBeNull();
      expect((await new Client("after-fail").post("/api/auth/invite/claim", { step: "options", token: tokenFromClaimPath(res.json.claimPath) })).status).toBe(200);
      expect(JSON.stringify(res.json)).not.toMatch(/stub|internal_server_error|rate_limit/); // no provider detail leaks to the browser
    });
  }
  it("a provider that never answers is cut off by the 10-second timeout", async () => {
    await stub.control("resend", "hang");
    const started = Date.now();
    const res = await invite(newInvitee("RESPONDENT", { sendEmail: true }).body);
    const elapsed = Date.now() - started;
    observe("03-invitations-email", "provider-timeout", { elapsedMs: elapsed, delivery: res.json?.delivery });
    expect(res.json.delivery).toBe("failed");
    expect(elapsed).toBeGreaterThan(9_000); expect(elapsed).toBeLessThan(14_000);
  });
  it("each replacement invitation uses its own idempotency key (a resend is a new invitation)", async () => {
    const { body } = newInvitee("RESPONDENT", { sendEmail: true });
    const a = await invite(body), b = await invite(body);
    const keys = (await stub.log("resend")).map((m) => m.idempotencyKey);
    expect(keys).toEqual([`invitation/${a.json.invitationId}`, `invitation/${b.json.invitationId}`]);
    expect(new Set(keys).size).toBe(2);
  });
});

describe("case notifications: transactional outbox, retries, no case content", () => {
  const notes = (caseId: string) => q<{ id: string; userId: string; kind: string; sentAt: Date | null; locale: string }>(`select * from "Notification" where "caseId"=$1 order by "createdAt"`, [caseId]);

  it("a submitted case notifies the activated respondent once, in their language, with a link and no case content", async () => {
    for (const locale of ["fr-CA", "en-CA"]) {
      await stub.reset();
      const r = await makeAccount("RESPONDENT", `note-${locale}`, locale);
      const { caseId } = await createCase(comp, r, { category: "TENANCY" });
      ok(await comp.client.post(`/api/cases/${caseId}/submit`), "submit");
      const log = await stub.log("resend");
      const [n] = await notes(caseId);
      expect(log, `locale ${locale}; notification row: ${JSON.stringify(n)}; respondent locale in DB: ${(await one<{ locale: string }>(`select locale from "User" where id=$1`, [r.userId]))?.locale}`).toHaveLength(1);
      expect(n.kind).toBe("case_submitted"); expect(n.sentAt).not.toBeNull();
      expect(log[0].idempotencyKey).toBe(`notification/${n.id}`);
      expect(log[0].body.to).toEqual([r.email]);
      expect(log[0].body.subject).toBe(locale === "fr-CA" ? "Une mise à jour dans Aequitas" : "An update in Aequitas");
      expect(log[0].body.text).toContain(`https://aequitas-audit.invalid/${locale}/cases/${caseId}`);
      const ref = (await one<{ referenceNumber: string }>(`select "referenceNumber" from "Case" where id=$1`, [caseId]))!.referenceNumber;
      for (const secret of [ref, comp.name, r.name, "TENANCY", "tenant"]) expect(log[0].body.text, `email must not contain ${secret}`).not.toContain(secret);
    }
  });
  it("a respondent with no passkey yet (placeholder) is not emailed; the notification waits", async () => {
    const { caseId } = await createCase(comp, syntheticEmail("unactivated"));
    ok(await comp.client.post(`/api/cases/${caseId}/submit`), "submit");
    expect(await stub.log("resend")).toHaveLength(0);
    const [n] = await notes(caseId);
    expect(n.sentAt).toBeNull();
  });
  it("provider failure never fails the case action; the notification is retained and a later retry delivers it once with the same idempotency key", async () => {
    await stub.control("resend", "http500");
    const r = await makeAccount("RESPONDENT", "retry-resp");
    const { caseId } = await createCase(comp, r);
    const submit = await comp.client.post(`/api/cases/${caseId}/submit`);
    expect(submit.status).toBe(200);
    const [n] = await notes(caseId);
    expect(n.sentAt).toBeNull();
    expect((await comp.client.request("PATCH", "/api/auth/invite")).status).toBe(403); // retry is an administrator action
    await stub.control("resend", "ok");
    const retry = await admin.client.request("PATCH", "/api/auth/invite");
    expect(retry.status).toBe(200);
    expect(retry.json.accepted).toBeGreaterThanOrEqual(1);
    const log = (await stub.log("resend")).filter((m) => m.body.to[0] === r.email);
    expect(log.map((m) => m.idempotencyKey)).toEqual([`notification/${n.id}`, `notification/${n.id}`]);
    expect((await notes(caseId))[0].sentAt).not.toBeNull();
    const again = await admin.client.request("PATCH", "/api/auth/invite");
    expect(again.json.accepted).toBe(0); // already delivered: not sent twice
    expect((await stub.log("resend")).filter((m) => m.body.to[0] === r.email)).toHaveLength(2);
  });
  it("one permanently failing recipient must not block every other recipient's notifications (head-of-line blocking)", async () => {
    // 21 undeliverable notifications for one address, then one deliverable notification created later.
    const bad = await makeAccount("RESPONDENT", "poison");
    const good = await makeAccount("RESPONDENT", "healthy");
    const { caseId } = await createCase(comp, good);
    for (let i = 0; i < 21; i++) await q(`insert into "Notification"(id,"userId","caseId",kind,locale,"createdAt") values ($1,$2,$3,'case_submitted','fr-CA', now() - interval '2 hours' + ($4 || ' seconds')::interval)`, [randomUUID(), bad.userId, caseId, String(i)]);
    await q(`insert into "Notification"(id,"userId","caseId",kind,locale) values ($1,$2,$3,'case_submitted','fr-CA')`, [randomUUID(), good.userId, caseId]);
    await q(`update "Notification" set "sentAt"=now() where "caseId"=$1 and "userId" not in ($2,$3)`, [caseId, bad.userId, good.userId]);
    await stub.control("resend", "fail_for", { emails: [bad.email] });
    for (let pass = 1; pass <= 3; pass++) await admin.client.request("PATCH", "/api/auth/invite");
    const delivered = (await q<{ n: string }>(`select count(*) n from "Notification" where "userId"=$1 and "caseId"=$2 and "sentAt" is not null`, [good.userId, caseId]))[0].n;
    const attempts = await stub.log("resend");
    observe("03-invitations-email", "outbox-starvation", { attemptsToBad: attempts.filter((m) => m.body.to[0] === bad.email).length, attemptsToHealthy: attempts.filter((m) => m.body.to[0] === good.email).length, healthyDelivered: Number(delivered) });
    expect(Number(delivered), "the healthy recipient's notification should be delivered despite 21 failing ones ahead of it").toBe(1);
  });
  it("observation: a slow provider delays the case action that triggered the notification", async () => {
    await stub.control("resend", "slow", { ms: 3000 });
    const r = await makeAccount("RESPONDENT", "slow-resp");
    const { caseId } = await createCase(comp, r);
    const started = Date.now();
    const submit = await comp.client.post(`/api/cases/${caseId}/submit`);
    const elapsed = Date.now() - started;
    observe("03-invitations-email", "notification-latency-coupling", { providerDelayMs: 3000, submitElapsedMs: elapsed, status: submit.status });
    expect(submit.status).toBe(200);
  });
});

describe("outbound isolation", () => {
  it("no request left the sandbox: the preload blocked nothing and the mock saw only mail.ts traffic", async () => {
    const denied = cfg.denyLog && existsSync(cfg.denyLog) ? readFileSync(cfg.denyLog, "utf8").trim() : "";
    observe("03-invitations-email", "outbound-denied-log", { lines: denied ? denied.split("\n").length : 0, sample: denied.slice(0, 200) });
    expect(denied).toBe("");
    await sleep(50);
    const log = await stub.log("resend");
    for (const m of log) expect(m.body.to[0]).toMatch(/@(audit\.example\.test)$/);
  });
});
