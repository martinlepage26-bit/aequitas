import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Client, setSuite } from "./lib/http";
import { observe } from "./lib/evidence";
import { caseEvents, closePool, one, q } from "./lib/db";
import { createCase, driveCase, makeAccount, makeCast, makeManager, ok, statementId, type Account, type Cast, type Stage } from "./lib/world";
import { evidenceForm, png } from "./lib/files";
import { verifyChain, legality } from "./lib/chain";
import { readZip } from "./lib/zip";

/**
 * Area 4: authorization and confidentiality. Expectations are written from the documented access rules
 * (src/domain/caseAccess.ts header, docs/security-release-20261003.md, handoff Section 10/16), not from the code under test.
 */
type Actor = "comp" | "resp" | "cm" | "cm2" | "admin" | "compOut" | "respOut" | "anon";
interface Scenario { stage: Stage; caseId: string; reference: string; unclaimed: boolean; hasDraft: boolean; recStatus: "none" | "DRAFT" | "ISSUED" }
let cast: Cast; let cm2: Account, compOut: Account, respOut: Account;
let actors: Record<Actor, Client>;
const scenarios: Scenario[] = [];
const DRAFT_MARKER = "record supports a review of dated materials"; // sentence produced by the mocked AI provider

beforeAll(async () => {
  setSuite("05-authorization");
  cast = await makeCast("authz");
  cm2 = await makeManager(cast.admin, "authz-cm2");
  compOut = await makeAccount("COMPLAINANT", "authz-comp-out");
  respOut = await makeAccount("RESPONDENT", "authz-resp-out");
  actors = { comp: cast.comp.client, resp: cast.resp.client, cm: cast.cm.client, cm2: cm2.client, admin: cast.admin.client, compOut: compOut.client, respOut: respOut.client, anon: new Client("anon") };
  const plan: Array<[Stage, Scenario["recStatus"], boolean]> = [["DRAFT", "none", true], ["OPEN", "none", true], ["EVIDENCE_INTAKE", "none", false], ["POSITIONS", "none", false], ["DRAFTING", "DRAFT", false], ["ISSUED", "ISSUED", false], ["CLOSED", "ISSUED", false]];
  for (const [stage, recStatus, unclaimed] of plan) {
    const { caseId } = await driveCase(cast, stage);
    const reference = (await one<{ referenceNumber: string }>(`select "referenceNumber" from "Case" where id=$1`, [caseId]))!.referenceNumber;
    scenarios.push({ stage, caseId, reference, unclaimed, hasDraft: recStatus !== "none", recStatus });
  }
});
afterAll(async () => { await closePool(); });

const isParty = (a: Actor) => a === "comp" || a === "resp";
function expectRead(a: Actor, s: Scenario): number {
  if (a === "anon") return 401;
  if (isParty(a) || a === "admin") return 200;
  if (a === "cm") return s.unclaimed ? 200 : 200; // cm is assigned whenever the case is past OPEN; for OPEN/DRAFT the first manager is "claimable"
  if (a === "cm2") return s.stage === "OPEN" && s.unclaimed ? 200 : 404;
  return 404;
}
/** DRAFT cases have no manager and are not claimable: nobody on the staff side except the admin may read them. */
function expectReadFor(a: Actor, s: Scenario): number {
  if (a === "anon") return 401;
  if (a === "cm") return s.stage === "DRAFT" ? 404 : 200;
  if (a === "cm2") return s.stage === "OPEN" ? 200 : 404;
  return expectRead(a, s);
}
function expectDraftRoute(a: Actor, s: Scenario): number { return a === "anon" ? 401 : a === "cm" && s.hasDraft ? 200 : 404; }
function expectKnowledge(a: Actor, s: Scenario): number {
  if (a === "anon") return 401;
  if (a === "cm") return s.hasDraft ? 200 : 404;
  if (isParty(a)) return s.recStatus === "ISSUED" ? 200 : 404;
  return 404;
}
function expectExport(a: Actor, s: Scenario): number {
  if (a === "anon") return 401;
  if (isParty(a)) return s.stage === "CLOSED" ? 200 : 404;
  if (a === "cm") return s.stage === "DRAFT" || s.stage === "OPEN" ? 404 : 200;
  if (a === "admin") return 200;
  return 404;
}

describe("read endpoints: every role x ownership x case state", () => {
  const endpoints: Array<{ name: string; path: (id: string) => string; expect: (a: Actor, s: Scenario) => number }> = [
    { name: "case projection", path: (id) => `/api/cases/${id}`, expect: expectReadFor },
    { name: "events", path: (id) => `/api/cases/${id}/events`, expect: expectReadFor },
    { name: "chronology", path: (id) => `/api/cases/${id}/chronology`, expect: expectReadFor },
    { name: "draft (reviewer only)", path: (id) => `/api/cases/${id}/draft`, expect: expectDraftRoute },
    { name: "knowledge map", path: (id) => `/api/cases/${id}/knowledge-map`, expect: expectKnowledge },
    { name: "export", path: (id) => `/api/cases/${id}/export`, expect: expectExport },
  ];
  for (const ep of endpoints) {
    it(`${ep.name}: allowed exactly where the access rules say, 404 otherwise, 401 anonymous`, async () => {
      const mismatches: string[] = [];
      for (const s of scenarios) {
        for (const a of Object.keys(actors) as Actor[]) {
          const res = await actors[a].get(ep.path(s.caseId));
          const want = ep.expect(a, s);
          if (res.status !== want) mismatches.push(`${a}@${s.stage}: expected ${want}, got ${res.status} ${res.text.slice(0, 60)}`);
        }
      }
      expect(mismatches, mismatches.join("\n")).toEqual([]);
    });
  }
  it("a refused read says the same thing as a read of a case that does not exist (generic denial)", async () => {
    const ghost = randomUUID();
    const odd: string[] = [];
    for (const ep of endpoints) {
      for (const a of ["compOut", "respOut", "cm2"] as Actor[]) {
        const s = scenarios.find((x) => x.stage === "EVIDENCE_INTAKE")!;
        const real = await actors[a].get(ep.path(s.caseId));
        const none = await actors[a].get(ep.path(ghost));
        if (real.status !== none.status || real.text !== none.text) odd.push(`${ep.name}/${a}: ${real.status} ${real.text.slice(0, 50)} vs ${none.status} ${none.text.slice(0, 50)}`);
      }
    }
    expect(odd, odd.join("\n")).toEqual([]);
  });
  it("storage keys, buckets, hashes of other parties' files and internal identifiers never appear in JSON read responses", async () => {
    const s = scenarios.find((x) => x.stage === "ISSUED")!;
    for (const path of [`/api/cases/${s.caseId}`, `/api/cases/${s.caseId}/events`, `/api/cases/${s.caseId}/chronology`, `/api/cases/${s.caseId}/knowledge-map`]) {
      for (const a of ["comp", "resp", "cm", "admin"] as Actor[]) {
        const res = await actors[a].get(path);
        if (res.status !== 200) continue;
        expect(res.text, `${a} ${path}`).not.toMatch(/storageKey|live\/[0-9a-f-]{36}|aequitas-audit-evidence|\/var\/|STORAGE_|\.zip/);
      }
    }
  });
});

describe("denial uniformity on write endpoints (no existence oracle)", () => {
  it("an outsider gets the same answer for a real case id and a non-existent one on every mutation route", async () => {
    const s = scenarios.find((x) => x.stage === "ISSUED")!;
    const ghost = randomUUID();
    const sid = await statementId();
    const tries: Array<[string, (id: string, who: Account) => Promise<{ status: number; text: string }>, Account[]]> = [
      ["submit", (id, w) => w.client.post(`/api/cases/${id}/submit`), [compOut, respOut]],
      ["withdraw", (id, w) => w.client.post(`/api/cases/${id}/withdraw`), [compOut, respOut]],
      ["open-intake", (id, w) => w.client.post(`/api/cases/${id}/open-intake`, { hasConflict: false }), [cm2]],
      ["close-intake", (id, w) => w.client.post(`/api/cases/${id}/close-intake`, {}), [cm2]],
      ["draft-requests", (id, w) => w.client.post(`/api/cases/${id}/draft-requests`), [cm2, compOut]],
      ["close", (id, w) => w.client.post(`/api/cases/${id}/close`), [cm2, compOut]],
      ["positions", (id, w) => w.client.post(`/api/cases/${id}/positions`, { body: "x" }), [compOut, respOut]],
      ["chronology", (id, w) => w.client.post(`/api/cases/${id}/chronology`, { occurredOn: "2026-01-01", title: "x", description: "x", locale: "en-CA" }), [compOut, respOut]],
      ["consent give", (id, w) => w.client.post(`/api/cases/${id}/consent`, { action: "give", statementVersionId: sid }), [compOut, respOut]],
      ["consent give (no statement)", (id, w) => w.client.post(`/api/cases/${id}/consent`, { action: "give" }), [compOut, respOut]],
      ["consent decline", (id, w) => w.client.post(`/api/cases/${id}/consent`, { action: "decline", statementVersionId: sid }), [compOut, respOut]],
      ["consent revoke", (id, w) => w.client.post(`/api/cases/${id}/consent`, { action: "revoke" }), [compOut, respOut]],
      ["draft review", (id, w) => w.client.patch(`/api/cases/${id}/draft`, { recommendationId: randomUUID(), explanation: {}, reason: "x" }), [cm2]],
    ];
    const odd: string[] = [];
    for (const [name, run, who] of tries) {
      for (const w of who) {
        const real = await run(s.caseId, w), none = await run(ghost, w);
        if (real.status !== none.status || real.text !== none.text) odd.push(`${name} as ${w.role}: existing -> ${real.status} ${real.text.slice(0, 70)} | missing -> ${none.status} ${none.text.slice(0, 70)}`);
      }
    }
    observe("05-authorization", "write-denial-oracles", { differences: odd });
    expect(odd, odd.join("\n")).toEqual([]);
  });
  it("issuing: an unrelated manager cannot tell a real recommendation id from a made-up one", async () => {
    const s = scenarios.find((x) => x.stage === "DRAFTING")!;
    const rec = (await one<{ currentRecommendationId: string }>(`select "currentRecommendationId" from "Case" where id=$1`, [s.caseId]))!.currentRecommendationId;
    const body = { checklist: { reviewedEvidence: true, confirmedLimits: true, acceptsResponsibility: true } };
    const real = await cm2.client.post(`/api/recommendations/${rec}/issue`, body);
    const none = await cm2.client.post(`/api/recommendations/${randomUUID()}/issue`, body);
    const asComp = await compOut.client.post(`/api/recommendations/${rec}/issue`, body);
    observe("05-authorization", "issue-denial", { realAsOtherManager: [real.status, real.text.slice(0, 60)], missing: [none.status, none.text.slice(0, 60)], realAsOutsider: [asComp.status, asComp.text.slice(0, 60)] });
    expect([real.status, real.text]).toEqual([none.status, none.text]);
    expect([asComp.status, asComp.text]).toEqual([none.status, none.text]);
    expect((await one<{ state: string }>(`select state from "Case" where id=$1`, [s.caseId]))!.state).toBe("DRAFTING"); // nothing was issued
  });
  it("ordinary party-to-case mismatches: another case's parties cannot act on this case", async () => {
    const s = scenarios.find((x) => x.stage === "EVIDENCE_INTAKE")!;
    const before = (await caseEvents(s.caseId)).length;
    for (const who of [compOut, respOut]) {
      expect((await who.client.post(`/api/cases/${s.caseId}/positions`, { body: "intruder" })).status).toBe(404);
      expect((await who.client.post(`/api/cases/${s.caseId}/chronology`, { occurredOn: "2026-01-01", title: "x", description: "x", locale: "en-CA" })).status).toBe(404);
    }
    expect((await caseEvents(s.caseId)).length).toBe(before);
  });
  it("anonymous callers get 401 on every API route and method", async () => {
    const id = scenarios[0].caseId, anon = new Client("anon");
    const routes: Array<[string, string]> = [["GET", `/api/cases/${id}`], ["POST", "/api/cases"], ["POST", `/api/cases/${id}/submit`], ["POST", `/api/cases/${id}/open-intake`], ["POST", `/api/cases/${id}/close-intake`], ["POST", `/api/cases/${id}/positions`],
      ["POST", `/api/cases/${id}/chronology`], ["GET", `/api/cases/${id}/chronology`], ["POST", `/api/cases/${id}/consent`], ["POST", `/api/cases/${id}/withdraw`], ["POST", `/api/cases/${id}/draft-requests`], ["GET", `/api/cases/${id}/draft`],
      ["PATCH", `/api/cases/${id}/draft`], ["POST", `/api/cases/${id}/close`], ["GET", `/api/cases/${id}/events`], ["GET", `/api/cases/${id}/export`], ["GET", `/api/cases/${id}/knowledge-map`], ["POST", `/api/cases/${id}/evidence`],
      ["POST", `/api/cases/${id}/evidence/${id}/supersede`], ["POST", `/api/recommendations/${id}/issue`], ["GET", "/api/auth/invite"], ["POST", "/api/auth/invite"], ["DELETE", "/api/auth/invite"], ["PATCH", "/api/auth/invite"]];
    for (const [method, path] of routes) {
      const res = await anon.request(method, path, { json: {} });
      expect(res.status, `${method} ${path}`).toBe(401);
      expect(res.json, `${method} ${path}`).toEqual({ message: "Not authenticated." });
    }
  });
  it("no evidence-download route exists: files can only leave the system through the export (documented as NOT SUPPORTED)", async () => {
    const s = scenarios.find((x) => x.stage === "POSITIONS")!;
    const ev = (await one<{ id: string }>(`select id from "EvidenceItem" where "caseId"=$1 limit 1`, [s.caseId]))!.id;
    for (const path of [`/api/cases/${s.caseId}/evidence`, `/api/cases/${s.caseId}/evidence/${ev}`, `/api/cases/${s.caseId}/evidence/${ev}/download`]) {
      for (const a of ["comp", "cm", "admin"] as Actor[]) {
        const res = await actors[a].get(path);
        expect([404, 405], `${a} GET ${path}`).toContain(res.status);
      }
    }
  });
});

describe("write endpoints: role x ownership matrix (denied actors change nothing; the entitled actor succeeds)", () => {
  type WriteActor = Exclude<Actor, "anon"> | "anon";
  interface WriteCase { name: string; stage: Stage; allowed: WriteActor[]; call: (who: Client, caseId: string, sid: string) => Promise<{ status: number; text: string }> }
  const checklist = { checklist: { reviewedEvidence: true, confirmedLimits: true, acceptsResponsibility: true } };
  const writes: WriteCase[] = [
    { name: "submit", stage: "DRAFT", allowed: ["comp"], call: (w, id) => w.post(`/api/cases/${id}/submit`) },
    { name: "open-intake", stage: "OPEN", allowed: ["cm", "cm2"], call: (w, id) => w.post(`/api/cases/${id}/open-intake`, { hasConflict: false }) },
    { name: "evidence", stage: "EVIDENCE_INTAKE", allowed: ["comp", "resp"], call: (w, id) => w.request("POST", `/api/cases/${id}/evidence`, { form: evidenceForm(png(), { title: "matrix" }) }) },
    { name: "chronology", stage: "EVIDENCE_INTAKE", allowed: ["comp", "resp"], call: (w, id) => w.post(`/api/cases/${id}/chronology`, { occurredOn: "2026-01-01", title: "m", description: "m", locale: "en-CA" }) },
    { name: "close-intake", stage: "EVIDENCE_INTAKE", allowed: ["cm"], call: (w, id) => w.post(`/api/cases/${id}/close-intake`, { overrideReason: "matrix" }) },
    { name: "positions", stage: "POSITIONS", allowed: ["comp", "resp"], call: (w, id) => w.post(`/api/cases/${id}/positions`, { body: "matrix" }) },
    { name: "draft-requests", stage: "POSITIONS", allowed: ["cm"], call: (w, id) => w.post(`/api/cases/${id}/draft-requests`) },
    { name: "issue", stage: "DRAFTING", allowed: ["cm"], call: async (w, id) => w.post(`/api/recommendations/${(await one<{ currentRecommendationId: string }>(`select "currentRecommendationId" from "Case" where id=$1`, [id]))!.currentRecommendationId}/issue`, checklist) },
    { name: "consent give", stage: "ISSUED", allowed: ["comp", "resp"], call: (w, id, sid) => w.post(`/api/cases/${id}/consent`, { action: "give", statementVersionId: sid }) },
    { name: "consent decline", stage: "ISSUED", allowed: ["comp", "resp"], call: (w, id, sid) => w.post(`/api/cases/${id}/consent`, { action: "decline", statementVersionId: sid }) },
    { name: "withdraw", stage: "POSITIONS", allowed: ["comp"], call: (w, id) => w.post(`/api/cases/${id}/withdraw`) },
    { name: "close", stage: "RESOLVED_CONSENT", allowed: ["cm"], call: (w, id) => w.post(`/api/cases/${id}/close`) },
  ];
  for (const w of writes) {
    it(`${w.name} (from ${w.stage}): allowed for ${w.allowed.join("/")} only`, async () => {
      const { caseId } = await driveCase(cast, w.stage);
      const sid = await statementId();
      const before = { events: (await caseEvents(caseId)).length, state: (await one<{ state: string }>(`select state from "Case" where id=$1`, [caseId]))!.state };
      const problems: string[] = [];
      const all = Object.keys(actors) as Actor[];
      const denied = all.filter((a) => !w.allowed.includes(a));
      for (const a of denied) {
        const res = await w.call(actors[a], caseId, sid);
        const wantStatus = a === "anon" ? [401] : a === "compOut" || a === "respOut" ? [404] : [403, 404, 409];
        if (!wantStatus.includes(res.status)) problems.push(`${a}: HTTP ${res.status} ${res.text.slice(0, 60)} (wanted ${wantStatus})`);
      }
      const events = (await caseEvents(caseId)).length;
      const state = (await one<{ state: string }>(`select state from "Case" where id=$1`, [caseId]))!.state;
      if (events !== before.events || state !== before.state) problems.push(`denied actors changed the case: events ${before.events}->${events}, state ${before.state}->${state}`);
      const entitled = await w.call(actors[w.allowed[0]], caseId, sid);
      if (entitled.status >= 300) problems.push(`entitled ${w.allowed[0]}: HTTP ${entitled.status} ${entitled.text.slice(0, 80)}`);
      expect(problems, problems.join("\n")).toEqual([]);
    });
  }
});

describe("pages: case list and workspace projection", () => {
  const listFor = async (a: Actor) => (await actors[a].get("/fr-CA/cases")).text;
  const references = (html: string) => new Set(html.match(/AE-\d{4}-\d{6}/g) ?? []);
  it("each role's case list contains exactly the cases it may open", async () => {
    const mine = new Set(scenarios.map((s) => s.reference));
    const expected: Record<Actor, Set<string>> = {
      comp: mine, resp: mine, cm: new Set(scenarios.filter((s) => !["DRAFT"].includes(s.stage)).map((s) => s.reference)),
      cm2: new Set(scenarios.filter((s) => s.stage === "OPEN").map((s) => s.reference)),
      admin: new Set(scenarios.filter((s) => s.stage === "OPEN").map((s) => s.reference)), compOut: new Set(), respOut: new Set(), anon: new Set(),
    };
    for (const a of ["comp", "resp", "cm", "cm2", "admin", "compOut", "respOut"] as Actor[]) {
      const html = await listFor(a);
      const got = [...references(html)].filter((r) => mine.has(r)).sort();
      const want = [...expected[a]].sort();
      expect(got, `${a}: case list`).toEqual(want);
    }
    expect((await actors.anon.get("/fr-CA/cases")).status).toBe(307);
  });
  it("the workspace page: 200 for entitled viewers, a bare 404 for everyone else, and no data leaks through the 404", async () => {
    const mismatches: string[] = [];
    for (const s of scenarios) {
      for (const a of Object.keys(actors) as Actor[]) {
        if (a === "anon") continue;
        const res = await actors[a].get(`/fr-CA/cases/${s.caseId}`);
        const want = expectReadFor(a, s);
        if (res.status !== want) mismatches.push(`${a}@${s.stage}: expected ${want} got ${res.status}`);
        if (res.status === 404) { for (const secret of [s.reference, cast.comp.name, cast.resp.name]) if (res.text.includes(secret)) mismatches.push(`${a}@${s.stage}: 404 page leaked ${secret}`); }
      }
      expect((await actors.anon.get(`/fr-CA/cases/${s.caseId}`)).status).toBe(307);
    }
    expect(mismatches, mismatches.join("\n")).toEqual([]);
  });
  it("DRAFT PRIVACY: the AI draft is shown only to the assigned reviewer, never to parties, other managers, admins or outsiders", async () => {
    const s = scenarios.find((x) => x.stage === "DRAFTING")!;
    const leaks: string[] = [];
    for (const a of Object.keys(actors) as Actor[]) {
      if (a === "anon") continue;
      const page = await actors[a].get(`/fr-CA/cases/${s.caseId}`);
      const shown = page.text.includes(DRAFT_MARKER);
      if (a === "cm" ? !shown : shown) leaks.push(`workspace page for ${a}: draft text ${shown ? "visible" : "missing"}`);
      for (const path of [`/api/cases/${s.caseId}/draft`, `/api/cases/${s.caseId}/knowledge-map`, `/api/cases/${s.caseId}/events`]) {
        const res = await actors[a].get(path);
        if (a !== "cm" && (res.text.includes(DRAFT_MARKER) || res.text.includes("RECOMMENDATION_DRAFTED") || res.text.includes("NOTE_ADDED"))) leaks.push(`${path} for ${a}`);
      }
    }
    expect(leaks, leaks.join("\n")).toEqual([]);
    // the reviewer's own timeline does include the quarantined event types
    const own = await actors.cm.get(`/api/cases/${s.caseId}/events`);
    expect(own.json.map((e: { type: string }) => e.type)).toContain("RECOMMENDATION_DRAFTED");
    const parties = await actors.comp.get(`/api/cases/${s.caseId}/events`);
    expect(parties.json.map((e: { type: string }) => e.type)).not.toContain("RECOMMENDATION_DRAFTED");
  });
  it("after issuing, parties and admins may read the issued recommendation (and only that version)", async () => {
    const s = scenarios.find((x) => x.stage === "ISSUED")!;
    for (const a of ["comp", "resp", "cm", "admin"] as Actor[]) expect((await actors[a].get(`/fr-CA/cases/${s.caseId}`)).text, a).toContain(DRAFT_MARKER);
    for (const a of ["cm2", "compOut", "respOut"] as Actor[]) expect((await actors[a].get(`/fr-CA/cases/${s.caseId}`)).text, a).not.toContain(DRAFT_MARKER);
  });
  it("a respondent cannot see a case the complainant has not submitted yet (existence, reference number, complainant name)", async () => {
    const s = scenarios.find((x) => x.stage === "DRAFT")!;
    const list = await listFor("resp");
    const api = await actors.resp.get(`/api/cases/${s.caseId}`);
    const page = await actors.resp.get(`/fr-CA/cases/${s.caseId}`);
    observe("05-authorization", "respondent-sees-draft-case", { listShowsReference: list.includes(s.reference), apiStatus: api.status, pageStatus: page.status, apiBodyKeys: api.json ? Object.keys(api.json) : null, complainantNameInApi: api.text.includes(cast.comp.name) });
    expect(api.status, "GET /api/cases/:id for an unsubmitted case").toBe(404);
    expect(page.status).toBe(404);
    expect(list).not.toContain(s.reference);
  });
});

describe("staff access is audited on the case's hash chain", () => {
  it("each administrator read appends exactly one ACCESS_STAFF_GRANTED naming the surface; no other role, and no refused read, appends one", async () => {
    const { caseId } = await driveCase(cast, "POSITIONS");
    const count = async () => (await caseEvents(caseId)).filter((e) => e.type === "ACCESS_STAFF_GRANTED");
    const base = (await count()).length;
    const surfaces: Array<[string, string]> = [["case", `/api/cases/${caseId}`], ["events", `/api/cases/${caseId}/events`], ["chronology", `/api/cases/${caseId}/chronology`], ["workspace", `/fr-CA/cases/${caseId}`], ["export", `/api/cases/${caseId}/export`]];
    for (const [surface, path] of surfaces) {
      const before = (await count()).length;
      const res = await actors.admin.get(path);
      expect(res.status, surface).toBe(200);
      const after = await count();
      expect(after.length, `${surface}: one audit event per read`).toBe(before + 1);
      expect(after.at(-1)!.payload).toEqual({ surface, authMethod: "passkey" });
      expect(after.at(-1)!.actorId).toBe(cast.admin.userId);
    }
    // refused admin reads (draft quarantine) write nothing
    const refusedBefore = (await count()).length;
    expect((await actors.admin.get(`/api/cases/${caseId}/draft`)).status).toBe(404);
    expect((await actors.admin.get(`/api/cases/${caseId}/knowledge-map`)).status).toBe(404);
    expect((await count()).length).toBe(refusedBefore);
    // other roles' reads write nothing
    for (const a of ["comp", "resp", "cm"] as Actor[]) { for (const [, path] of surfaces.slice(0, 4)) await actors[a].get(path); }
    for (const a of ["compOut", "respOut", "cm2"] as Actor[]) { for (const [, path] of surfaces) await actors[a].get(path); }
    expect((await count()).length).toBe(refusedBefore);
    expect(base).toBe(0);
    const events = await caseEvents(caseId);
    expect(verifyChain(events)).toEqual([]);
    expect(legality(events).issues).toEqual([]);
  });
  it("30 simultaneous administrator reads leave a gap-free, valid chain with 30 audit events", async () => {
    const { caseId } = await driveCase(cast, "EVIDENCE_INTAKE");
    const before = (await caseEvents(caseId)).length;
    const results = await Promise.all(Array.from({ length: 30 }, () => actors.admin.get(`/api/cases/${caseId}`)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    const events = await caseEvents(caseId);
    expect(events.length).toBe(before + 30);
    expect(events.slice(before).every((e) => e.type === "ACCESS_STAFF_GRANTED")).toBe(true);
    expect(verifyChain(events)).toEqual([]);
  });
  it("an administrator's export request on a case that has no export yet generates one (a read with a write side effect)", async () => {
    const { caseId } = await driveCase(cast, "POSITIONS");
    const before = Number((await one<{ n: string }>(`select count(*) n from "ExportBundle" where "caseId"=$1`, [caseId]))!.n);
    const res = await actors.admin.get(`/api/cases/${caseId}/export`);
    const after = Number((await one<{ n: string }>(`select count(*) n from "ExportBundle" where "caseId"=$1`, [caseId]))!.n);
    observe("05-authorization", "admin-export-generates", { status: res.status, bundlesBefore: before, bundlesAfter: after });
    const zip = readZip((await actors.admin.bytes(`/api/cases/${caseId}/export`)).body);
    observe("05-authorization", "admin-export-entries", { entries: [...zip.keys()] });
    expect(res.status).toBe(200);
    expect(after).toBeGreaterThanOrEqual(1);
  });
});
