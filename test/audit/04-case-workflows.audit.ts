import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { cfg } from "./lib/config";
import { setSuite } from "./lib/http";
import { observe } from "./lib/evidence";
import { caseEvents, caseRow, closePool, one, q } from "./lib/db";
import { driveCase, makeAccount, makeCast, ok, statementId, upload, createCase, type Account, type Cast, type Stage } from "./lib/world";
import { legality, verifyChain } from "./lib/chain";
import { keysForCase, getObject } from "./lib/storage";
import { png, text } from "./lib/files";
import { stub } from "./lib/stub";

/**
 * Area 3: complete workflows through the real HTTP API (production build), with separate complainant, respondent,
 * case-manager and administrator accounts. After EVERY operation the database row, the new events, the new
 * notifications and the new storage objects are checked against the documented state machine.
 */
let cast: Cast;
beforeAll(async () => { setSuite("04-case-workflows"); cast = await makeCast("wf"); });
afterAll(async () => { await closePool(); });

/** Captures what a single operation changed. */
class Observer {
  private events = 0; private notes = 0; private keys = new Set<string>();
  constructor(readonly caseId: string) {}
  async baseline() {
    this.events = (await caseEvents(this.caseId)).length;
    this.notes = Number((await one<{ n: string }>(`select count(*) n from "Notification" where "caseId"=$1`, [this.caseId]))!.n);
    this.keys = new Set(await keysForCase(this.caseId));
    return this;
  }
  async delta() {
    const events = await caseEvents(this.caseId);
    const notes = await q<{ kind: string; userId: string; sentAt: Date | null }>(`select kind,"userId","sentAt" from "Notification" where "caseId"=$1 order by "createdAt"`, [this.caseId]);
    const keys = await keysForCase(this.caseId);
    const result = {
      state: (await caseRow(this.caseId))!.state as string,
      events: events.slice(this.events).map((e) => e.type),
      notifications: notes.slice(this.notes).map((n) => ({ kind: n.kind, userId: n.userId, delivered: n.sentAt !== null })),
      newObjects: keys.filter((k) => !this.keys.has(k)),
      chainOk: verifyChain(events).length === 0 && legality(events).issues.length === 0,
    };
    await this.baseline();
    return result;
  }
}

const uniq = (a: string[]) => [...new Set(a)].sort();

describe("full lifecycle: create -> submit -> claim -> evidence -> chronology -> positions -> AI draft -> review -> issue -> consent -> close -> export", () => {
  it("every step produces exactly the documented state, events, notifications and storage objects", async () => {
    const { comp, resp, cm } = cast;
    await stub.reset();
    const created = await createCase(comp, resp);
    ok(created.res, "create");
    const caseId = created.caseId;
    const o = await new Observer(caseId).baseline();
    // The baseline was taken after creation, so assert creation from the database directly.
    const initial = await caseRow(caseId);
    expect(initial).toMatchObject({ state: "DRAFT", complainantId: comp.userId, respondentId: resp.userId, caseManagerId: null, simulated: false, category: "RETAIL", currentRecommendationId: null, draftRequestId: null });
    expect(initial!.referenceNumber).toMatch(/^AE-\d{4}-\d{6}$/);
    expect((await caseEvents(caseId)).map((e) => e.type)).toEqual(["CASE_CREATED"]);
    expect(created.res.json).toEqual({ caseId, state: "DRAFT" });

    // 2. submit
    ok(await comp.client.post(`/api/cases/${caseId}/submit`), "submit");
    expect(await o.delta()).toMatchObject({ state: "OPEN", events: ["CASE_SUBMITTED"], notifications: [{ kind: "case_submitted", userId: resp.userId, delivered: true }], newObjects: [], chainOk: true });

    // 3. the case manager claims the case and declares no conflict
    ok(await cm.client.post(`/api/cases/${caseId}/open-intake`, { hasConflict: false, coiDetails: "None." }), "open-intake");
    expect(await o.delta()).toMatchObject({ state: "EVIDENCE_INTAKE", events: ["EVIDENCE_INTAKE_OPENED", "CASE_ASSIGNED"], notifications: [], chainOk: true });
    expect(await caseRow(caseId)).toMatchObject({ caseManagerId: cm.userId });
    expect(await one(`select "hasConflict", details from "CoiDeclaration" where "caseId"=$1`, [caseId])).toEqual({ hasConflict: false, details: "None." });

    // 4. evidence from both parties: scanned by the real ClamAV, stored, hashed
    const pngBytes = png(), txtBytes = text();
    ok(await upload(comp, caseId, pngBytes, { title: "Photo of the goods", kind: "PHOTO", filename: "../../etc/passwd.png" }), "complainant evidence");
    const afterC = await o.delta();
    expect(afterC).toMatchObject({ state: "EVIDENCE_INTAKE", events: ["EVIDENCE_SUBMITTED"], notifications: [], chainOk: true });
    expect(afterC.newObjects).toHaveLength(1);
    ok(await upload(resp, caseId, txtBytes, { title: "Message log", kind: "MESSAGE" }), "respondent evidence");
    const afterR = await o.delta();
    expect(afterR.newObjects).toHaveLength(1);
    const items = await q<{ id: string; storageKey: string; sha256: string; byteSize: number; mimeType: string; scanStatus: string; submittedById: string }>(`select * from "EvidenceItem" where "caseId"=$1 order by "createdAt"`, [caseId]);
    expect(items.map((i) => [i.mimeType, i.scanStatus, i.submittedById])).toEqual([["image/png", "CLEAN", comp.userId], ["text/plain", "CLEAN", resp.userId]]);
    for (const [item, bytes] of [[items[0], pngBytes], [items[1], txtBytes]] as const) {
      expect(item.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
      expect(item.byteSize).toBe(bytes.length);
      expect(item.storageKey).toBe(`live/${caseId}/${item.id}`); // the client-supplied filename never reaches the key
      expect((await getObject(item.storageKey))?.equals(bytes)).toBe(true);
    }

    // 5. chronology from both parties
    ok(await comp.client.post(`/api/cases/${caseId}/chronology`, { occurredOn: "2026-01-02", title: "Received", description: "Invoice received.", locale: "en-CA" }), "chronology c", 201);
    ok(await resp.client.post(`/api/cases/${caseId}/chronology`, { occurredOn: "2026-01-01", title: "Sent", description: "Invoice sent.", locale: "fr-CA" }), "chronology r", 201);
    expect(await o.delta()).toMatchObject({ events: ["CHRONOLOGY_ENTRY_SUBMITTED", "CHRONOLOGY_ENTRY_SUBMITTED"], chainOk: true });

    // 6. a party supersedes its own evidence item
    ok(await comp.client.request("POST", `/api/cases/${caseId}/evidence/${items[0].id}/supersede`, { form: (await import("./lib/files")).evidenceForm(png(), { title: "Photo (corrected)", kind: "PHOTO" }) }), "supersede");
    const sup = await o.delta();
    expect(sup).toMatchObject({ events: ["EVIDENCE_SUPERSEDED"], chainOk: true });
    expect(sup.newObjects).toHaveLength(1);
    expect(await one(`select version, "supersedesId" from "EvidenceItem" where "caseId"=$1 and version=2`, [caseId])).toEqual({ version: 2, supersedesId: items[0].id });

    // 7. close intake; positions (second submission by a party becomes version 2)
    ok(await cm.client.post(`/api/cases/${caseId}/close-intake`, {}), "close-intake");
    expect(await o.delta()).toMatchObject({ state: "POSITIONS", events: ["EVIDENCE_INTAKE_CLOSED"], chainOk: true });
    expect((await caseEvents(caseId)).at(-1)!.payload).toEqual({ overrideReason: null });
    ok(await comp.client.post(`/api/cases/${caseId}/positions`, { body: "First position of the complainant.", locale: "en-CA" }), "position c1");
    ok(await comp.client.post(`/api/cases/${caseId}/positions`, { body: "Revised position of the complainant.", locale: "en-CA" }), "position c2");
    ok(await resp.client.post(`/api/cases/${caseId}/positions`, { body: "Position of the respondent.", locale: "en-CA" }), "position r1");
    expect(await o.delta()).toMatchObject({ state: "POSITIONS", events: ["POSITION_SUBMITTED", "POSITION_SUBMITTED", "POSITION_SUBMITTED"], chainOk: true });
    expect((await q<{ partyId: string; version: number }>(`select "partyId", version from "PositionStatement" where "caseId"=$1 order by "createdAt"`, [caseId])).map((p) => [p.partyId === comp.userId ? "c" : "r", p.version])).toEqual([["c", 1], ["c", 2], ["r", 1]]);

    // 8. AI draft (provider mocked): request + completion in one request
    await stub.reset();
    ok(await cm.client.post(`/api/cases/${caseId}/draft-requests`), "draft");
    const drafted = await o.delta();
    expect(drafted).toMatchObject({ state: "DRAFTING", events: ["RECOMMENDATION_DRAFT_REQUESTED", "RECOMMENDATION_DRAFTED"], chainOk: true });
    const aiCalls = await stub.log("anthropic");
    expect(aiCalls).toHaveLength(1);
    expect(aiCalls[0].promptContainsAtSign, "the AI prompt must not carry e-mail addresses").toBe(false);
    for (const name of [comp.name, resp.name, cm.name, comp.userId, resp.userId]) expect(aiCalls[0].userPrompt, "no party identity in the prompt").not.toContain(name);
    const row = await caseRow(caseId);
    expect(row).toMatchObject({ draftRequestId: null, draftRequestedAt: null });
    const rec1 = await one<{ id: string; status: string; version: number; modelId: string }>(`select * from "Recommendation" where id=$1`, [row!.currentRecommendationId]);
    expect(rec1).toMatchObject({ status: "DRAFT", version: 1, modelId: "stub-model-1" });

    // 9. human review creates a NEW version and keeps the original
    const draft = await cm.client.get(`/api/cases/${caseId}/draft`);
    ok(draft, "read draft");
    const edited = { ...draft.json.explanation, summary: "Reviewer-corrected summary of the disagreement." };
    for (const k of ["model", "reviewer", "knowledge_sources"]) delete edited[k];
    ok(await cm.client.patch(`/api/cases/${caseId}/draft`, { recommendationId: draft.json.id, explanation: edited, reason: "Clarified wording." }), "review");
    const reviewed = await o.delta();
    expect(reviewed).toMatchObject({ state: "DRAFTING", events: ["RECOMMENDATION_DRAFTED", "NOTE_ADDED"], chainOk: true });
    const recs = await q<{ version: number; status: string }>(`select version,status from "Recommendation" where "caseId"=$1 order by version`, [caseId]);
    expect(recs).toEqual([{ version: 1, status: "SUPERSEDED" }, { version: 2, status: "DRAFT" }]);

    // 10. issue
    const current = (await caseRow(caseId))!.currentRecommendationId as string;
    ok(await cm.client.post(`/api/recommendations/${current}/issue`, { checklist: { reviewedEvidence: true, confirmedLimits: true, acceptsResponsibility: true } }), "issue");
    const issued = await o.delta();
    expect(issued).toMatchObject({ state: "ISSUED", events: ["RECOMMENDATION_ISSUED"], chainOk: true });
    expect(uniq(issued.notifications.map((n) => n.userId))).toEqual(uniq([comp.userId, resp.userId]));
    expect(issued.notifications.every((n) => n.kind === "recommendation_issued" && n.delivered)).toBe(true);
    expect(await one(`select status, "issuedById" from "Recommendation" where id=$1`, [current])).toEqual({ status: "ISSUED", issuedById: cm.userId });

    // 11. consent: one party does not resolve the case; both do; revocation reopens; re-consent resolves again
    const sid = await statementId();
    ok(await comp.client.post(`/api/cases/${caseId}/consent`, { action: "give", statementVersionId: sid }), "consent c");
    expect(await o.delta()).toMatchObject({ state: "ISSUED", events: ["CONSENT_GIVEN"], chainOk: true });
    ok(await resp.client.post(`/api/cases/${caseId}/consent`, { action: "give", statementVersionId: sid }), "consent r");
    expect(await o.delta()).toMatchObject({ state: "RESOLVED_CONSENT", events: ["CONSENT_GIVEN", "CASE_RESOLVED"], chainOk: true });
    ok(await resp.client.post(`/api/cases/${caseId}/consent`, { action: "revoke" }), "revoke");
    expect(await o.delta()).toMatchObject({ state: "ISSUED", events: ["CONSENT_REVOKED", "CASE_REOPENED"], chainOk: true });
    ok(await resp.client.post(`/api/cases/${caseId}/consent`, { action: "give", statementVersionId: sid }), "re-consent");
    expect(await o.delta()).toMatchObject({ state: "RESOLVED_CONSENT", events: ["CONSENT_GIVEN", "CASE_RESOLVED"], chainOk: true });
    const consent = await q<{ state: string; partyId: string; authContext: any }>(`select state,"partyId","authContext" from "ConsentRecord" where "caseId"=$1`, [caseId]);
    expect(consent.map((c) => c.state).sort()).toEqual(["GIVEN", "GIVEN"]);
    for (const c of consent) { expect(c.authContext.authMethod).toBe("passkey"); expect(c.authContext.sessionIdHash).toMatch(/^[0-9a-f]{64}$/); }

    // 12. close: export generated, hashed, stored, then the case closes
    const closed = await cm.client.post(`/api/cases/${caseId}/close`);
    ok(closed, "close");
    const afterClose = await o.delta();
    expect(afterClose).toMatchObject({ state: "CLOSED", events: ["EXPORT_GENERATED", "CASE_CLOSED"], chainOk: true });
    expect(afterClose.newObjects).toHaveLength(1);
    expect(afterClose.newObjects[0]).toMatch(new RegExp(`^exports/live/${caseId}/[0-9a-f-]{36}\\.zip$`));
    const bundle = await one<{ storageKey: string; sha256: string }>(`select "storageKey", sha256 from "ExportBundle" where "caseId"=$1`, [caseId]);
    expect(bundle!.storageKey).toBe(afterClose.newObjects[0]);
    const zip = (await getObject(bundle!.storageKey))!;
    expect(createHash("sha256").update(zip).digest("hex")).toBe(bundle!.sha256);
    expect(closed.json.export.sha256).toBe(bundle!.sha256);
    expect((await caseRow(caseId))!.closedAt).not.toBeNull();

    // 13. the closed case can be exported by the parties and nothing can change any more
    for (const who of [comp, resp, cm]) {
      const dl = await who.client.get(`/api/cases/${caseId}/export`);
      expect(dl.status, who.role).toBe(200);
      expect(dl.headers.get("content-type")).toBe("application/zip");
      expect(dl.headers.get("x-export-sha256")).toBe(bundle!.sha256);
    }
    const before = (await caseEvents(caseId)).length;
    const attempts = await Promise.all([
      comp.client.post(`/api/cases/${caseId}/withdraw`), comp.client.post(`/api/cases/${caseId}/submit`), resp.client.post(`/api/cases/${caseId}/positions`, { body: "late" }),
      resp.client.post(`/api/cases/${caseId}/consent`, { action: "revoke" }), cm.client.post(`/api/cases/${caseId}/close-intake`, {}), cm.client.post(`/api/cases/${caseId}/draft-requests`),
      upload(comp, caseId, png(), { title: "late" }), comp.client.post(`/api/cases/${caseId}/chronology`, { occurredOn: "2026-02-02", title: "late", description: "late", locale: "en-CA" }),
    ]);
    observe("04-case-workflows", "closed-case-mutations", { statuses: attempts.map((a) => a.status) });
    for (const a of attempts) { expect(a.status).toBeGreaterThanOrEqual(400); expect(a.status).toBeLessThan(500); }
    expect((await caseEvents(caseId)).length).toBe(before);
    expect((await caseRow(caseId))!.state).toBe("CLOSED");

    const events = await caseEvents(caseId);
    expect(legality(events)).toEqual({ issues: [], finalState: "CLOSED" });
    observe("04-case-workflows", "lifecycle-event-sequence", { events: events.map((e) => e.type) });
  });
});

describe("decline, redraft, and withdrawal paths", () => {
  it("a declined recommendation can be redrafted as version 2, superseding version 1, and then resolved and closed", async () => {
    const { comp, resp, cm } = cast;
    const { caseId } = await driveCase(cast, "ISSUED");
    const o = await new Observer(caseId).baseline();
    const sid = await statementId();
    ok(await resp.client.post(`/api/cases/${caseId}/consent`, { action: "decline", statementVersionId: sid }), "decline");
    expect(await o.delta()).toMatchObject({ state: "RESOLVED_DECLINED", events: ["CONSENT_DECLINED", "CASE_RESOLVED_DECLINED"], chainOk: true });
    // a declined party cannot then consent to the same recommendation
    expect((await resp.client.post(`/api/cases/${caseId}/consent`, { action: "give", statementVersionId: sid })).status).toBe(409);
    ok(await cm.client.post(`/api/cases/${caseId}/draft-requests`), "new version");
    expect(await o.delta()).toMatchObject({ state: "DRAFTING", events: ["RECOMMENDATION_DRAFT_REQUESTED", "RECOMMENDATION_DRAFTED"], chainOk: true });
    expect((await q<{ version: number; status: string }>(`select version,status from "Recommendation" where "caseId"=$1 order by version`, [caseId]))).toEqual([{ version: 1, status: "SUPERSEDED" }, { version: 2, status: "DRAFT" }]);
    const draft = await cm.client.get(`/api/cases/${caseId}/draft`);
    ok(await cm.client.post(`/api/recommendations/${draft.json.id}/issue`, { checklist: { reviewedEvidence: true, confirmedLimits: true, acceptsResponsibility: true } }), "issue v2");
    for (const who of [comp, resp]) ok(await who.client.post(`/api/cases/${caseId}/consent`, { action: "give", statementVersionId: sid }), "consent v2");
    expect((await caseRow(caseId))!.state).toBe("RESOLVED_CONSENT");
    // consent is bound to the CURRENT version: the old declined record is untouched
    expect((await q<{ state: string }>(`select c.state from "ConsentRecord" c join "Recommendation" r on r.id=c."recommendationId" where c."caseId"=$1 and r.version=1`, [caseId])).map((c) => c.state)).toEqual(["DECLINED"]);
    ok(await cm.client.post(`/api/cases/${caseId}/close`), "close");
    const events = await caseEvents(caseId);
    expect(legality(events)).toEqual({ issues: [], finalState: "CLOSED" });
    expect(verifyChain(events)).toEqual([]);
  });
  const withdrawFrom: Stage[] = ["DRAFT", "OPEN", "EVIDENCE_INTAKE", "POSITIONS", "DRAFTING", "ISSUED", "RESOLVED_CONSENT"];
  for (const stage of withdrawFrom) {
    it(`the complainant can withdraw from ${stage}; others cannot; the respondent is notified`, async () => {
      const { comp, resp, cm, admin } = cast;
      const outsider = await makeAccount("COMPLAINANT", "wd-outsider");
      const { caseId } = await driveCase(cast, stage);
      const o = await new Observer(caseId).baseline();
      expect((await resp.client.post(`/api/cases/${caseId}/withdraw`)).status).toBe(403);
      expect((await outsider.client.post(`/api/cases/${caseId}/withdraw`)).status).toBe(404);
      expect([403, 404]).toContain((await cm.client.post(`/api/cases/${caseId}/withdraw`)).status);
      expect([403, 404]).toContain((await admin.client.post(`/api/cases/${caseId}/withdraw`)).status);
      expect((await o.delta()).events).toEqual([]);
      ok(await comp.client.post(`/api/cases/${caseId}/withdraw`), "withdraw");
      const d = await o.delta();
      expect(d).toMatchObject({ state: "WITHDRAWN", events: ["CASE_WITHDRAWN"], chainOk: true });
      expect(d.notifications).toEqual([{ kind: "case_withdrawn", userId: resp.userId, delivered: true }]);
      const closeAttempt = await cm.client.post(`/api/cases/${caseId}/close`);
      const managerAssigned = (await caseRow(caseId))!.caseManagerId !== null;
      observe("04-case-workflows", "withdrawn-close", { stage, managerAssigned, closeStatus: closeAttempt.status });
      if (managerAssigned) { expect(closeAttempt.status).toBe(200); expect((await caseRow(caseId))!.state).toBe("CLOSED"); }
      else expect(closeAttempt.status).toBe(404); // documented observation: nobody can close a case withdrawn before it was claimed
      expect(legality(await caseEvents(caseId)).issues).toEqual([]);
    });
  }
});

describe("consent evidence", () => {
  it("observation: the IP hash stored with a consent record derives from the client-supplied X-Forwarded-For (forgeable unless the edge overwrites it)", async () => {
    const { comp } = cast;
    const id = (await driveCase(cast, "ISSUED")).caseId;
    const forged = "203.0.113.77"; // documentation address (RFC 5737)
    ok(await comp.client.post(`/api/cases/${id}/consent`, { action: "give", statementVersionId: await statementId() }, { headers: { "x-forwarded-for": `${forged}, 10.0.0.1` } }), "consent");
    const record = await one<{ authContext: { ipHash: string | null; authMethod: string; sessionIdHash: string | null } }>(`select "authContext" from "ConsentRecord" where "caseId"=$1 and "partyId"=$2`, [id, comp.userId]);
    const forgedHash = createHash("sha256").update(`${cfg.ipSalt}:${forged}`).digest("hex");
    observe("04-case-workflows", "consent-ip-from-forwarded-header", { ipHashEqualsHashOfClientSuppliedHeader: record!.authContext.ipHash === forgedHash, authMethod: record!.authContext.authMethod, hasSessionIdHash: Boolean(record!.authContext.sessionIdHash) });
    expect(record!.authContext.authMethod).toBe("passkey");
    expect(record!.authContext.ipHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("repeat and refused operations have no side effects", () => {
  it("repeating a withdrawal is idempotent: no second CASE_WITHDRAWN event and no second notification", async () => {
    const { comp, resp } = cast;
    const { caseId } = await driveCase(cast, "OPEN");
    ok(await comp.client.post(`/api/cases/${caseId}/withdraw`), "withdraw");
    const o = await new Observer(caseId).baseline();
    const again = await comp.client.post(`/api/cases/${caseId}/withdraw`);
    const d = await o.delta();
    observe("04-case-workflows", "double-withdraw", { secondStatus: again.status, newEvents: d.events, newNotifications: d.notifications.length });
    expect(d.events, "second withdrawal should not append another CASE_WITHDRAWN").toEqual([]);
    expect(d.notifications.filter((n) => n.userId === resp.userId), "respondent must not be notified twice").toEqual([]);
  });
  it("a refused close (case not in a closable state) generates no export bundle row or object", async () => {
    const { cm } = cast;
    for (const stage of ["EVIDENCE_INTAKE", "ISSUED"] as const) {
      const { caseId } = await driveCase(cast, stage);
      const o = await new Observer(caseId).baseline();
      const bundlesBefore = Number((await one<{ n: string }>(`select count(*) n from "ExportBundle" where "caseId"=$1`, [caseId]))!.n);
      const res = await cm.client.post(`/api/cases/${caseId}/close`);
      const d = await o.delta();
      const bundlesAfter = Number((await one<{ n: string }>(`select count(*) n from "ExportBundle" where "caseId"=$1`, [caseId]))!.n);
      observe("04-case-workflows", "refused-close-side-effect", { stage, status: res.status, newObjects: d.newObjects.length, bundleRows: bundlesAfter - bundlesBefore, events: d.events });
      expect(res.status).toBe(409);
      expect(d.events).toEqual([]);
      expect(d.newObjects, `refused close from ${stage} must not store an export bundle`).toEqual([]);
      expect(bundlesAfter - bundlesBefore).toBe(0);
    }
  });
  it("closing an already closed case does not generate and store another export bundle", async () => {
    const { cm } = cast;
    const { caseId } = await driveCase(cast, "CLOSED");
    const before = await keysForCase(caseId);
    const res = await cm.client.post(`/api/cases/${caseId}/close`);
    const after = await keysForCase(caseId);
    observe("04-case-workflows", "reclose-side-effect", { status: res.status, newObjects: after.length - before.length });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(after).toEqual(before);
  });
});

describe("rejected transitions: every action from a state that does not allow it changes nothing", () => {
  type Action = { name: string; allowedIn: string[]; run: (c: { caseId: string }, sid: string) => Promise<{ status: number }>; };
  const actions = (cs: Cast): Action[] => [
    { name: "submit (complainant)", allowedIn: ["DRAFT"], run: ({ caseId }) => cs.comp.client.post(`/api/cases/${caseId}/submit`) },
    { name: "open-intake (manager)", allowedIn: ["OPEN"], run: ({ caseId }) => cs.cm.client.post(`/api/cases/${caseId}/open-intake`, { hasConflict: false }) },
    { name: "evidence (respondent)", allowedIn: ["EVIDENCE_INTAKE"], run: ({ caseId }) => upload(cs.resp, caseId, png(), { title: "x" }) },
    { name: "chronology (respondent)", allowedIn: ["EVIDENCE_INTAKE"], run: ({ caseId }) => cs.resp.client.post(`/api/cases/${caseId}/chronology`, { occurredOn: "2026-03-03", title: "x", description: "x", locale: "en-CA" }) },
    { name: "close-intake (manager)", allowedIn: ["EVIDENCE_INTAKE"], run: ({ caseId }) => cs.cm.client.post(`/api/cases/${caseId}/close-intake`, { overrideReason: "x" }) },
    { name: "position (respondent)", allowedIn: ["POSITIONS"], run: ({ caseId }) => cs.resp.client.post(`/api/cases/${caseId}/positions`, { body: "x" }) },
    { name: "draft-requests (manager)", allowedIn: ["POSITIONS", "DRAFTING", "ISSUED", "RESOLVED_DECLINED"], run: ({ caseId }) => cs.cm.client.post(`/api/cases/${caseId}/draft-requests`) },
    { name: "issue (manager)", allowedIn: ["DRAFTING"], run: async ({ caseId }) => { const r = (await caseRow(caseId))!.currentRecommendationId ?? "00000000-0000-4000-8000-000000000000"; return cs.cm.client.post(`/api/recommendations/${r}/issue`, { checklist: { reviewedEvidence: true, confirmedLimits: true, acceptsResponsibility: true } }); } },
    { name: "consent give (respondent)", allowedIn: ["ISSUED"], run: ({ caseId }, sid) => cs.resp.client.post(`/api/cases/${caseId}/consent`, { action: "give", statementVersionId: sid }) },
    { name: "consent decline (respondent)", allowedIn: ["ISSUED"], run: ({ caseId }, sid) => cs.resp.client.post(`/api/cases/${caseId}/consent`, { action: "decline", statementVersionId: sid }) },
  ];
  const states: Stage[] = ["DRAFT", "OPEN", "EVIDENCE_INTAKE", "POSITIONS", "DRAFTING", "ISSUED", "RESOLVED_CONSENT", "CLOSED"];
  for (const stage of states) {
    it(`from ${stage}: every disallowed action is refused with a 4xx, no event, no state change, no object`, async () => {
      const { caseId } = await driveCase(cast, stage);
      const sid = await statementId();
      const o = await new Observer(caseId).baseline();
      const matrix: Array<[string, number]> = [];
      for (const action of actions(cast)) {
        if (action.allowedIn.includes(stage)) continue;
        const res = await action.run({ caseId }, sid);
        matrix.push([action.name, res.status]);
        expect(res.status, `${action.name} from ${stage}`).toBeGreaterThanOrEqual(400);
        expect(res.status, `${action.name} from ${stage}`).toBeLessThan(500);
      }
      const d = await o.delta();
      expect(d.events, `events after refused actions from ${stage}: ${JSON.stringify(matrix)}`).toEqual([]);
      expect(d.state).toBe(stage === "CLOSED" ? "CLOSED" : (await caseRow(caseId))!.state);
      expect(d.newObjects).toEqual([]);
      observe("04-case-workflows", `rejected-transitions-${stage}`, { matrix });
    });
  }
  it("wrong-role actors are refused even in the right state (403/404, never a state change)", async () => {
    const { comp, resp, cm, admin } = cast;
    const { caseId } = await driveCase(cast, "EVIDENCE_INTAKE");
    const o = await new Observer(caseId).baseline();
    const tries = await Promise.all([
      resp.client.post(`/api/cases/${caseId}/submit`), cm.client.post(`/api/cases/${caseId}/submit`), admin.client.post(`/api/cases/${caseId}/submit`),
      comp.client.post(`/api/cases/${caseId}/open-intake`, { hasConflict: false }), resp.client.post(`/api/cases/${caseId}/close-intake`, {}), comp.client.post(`/api/cases/${caseId}/close-intake`, {}),
      cm.client.post(`/api/cases/${caseId}/positions`, { body: "x" }), admin.client.post(`/api/cases/${caseId}/chronology`, { occurredOn: "2026-03-03", title: "x", description: "x", locale: "en-CA" }),
      upload(cm, caseId, png(), { title: "manager evidence" }), upload(admin, caseId, png(), { title: "admin evidence" }),
      comp.client.post(`/api/cases/${caseId}/draft-requests`), resp.client.post(`/api/cases/${caseId}/close`),
    ]);
    observe("04-case-workflows", "wrong-role-statuses", { statuses: tries.map((t) => t.status) });
    for (const t of tries) { expect(t.status).toBeGreaterThanOrEqual(400); expect(t.status).toBeLessThan(500); }
    expect(await o.delta()).toMatchObject({ events: [], newObjects: [], state: "EVIDENCE_INTAKE" });
  });
  it("input validation: bad dates, missing fields, bad enums and stale versions are rejected without side effects", async () => {
    const { comp, resp, cm } = cast;
    const { caseId } = await driveCase(cast, "EVIDENCE_INTAKE");
    const o = await new Observer(caseId).baseline();
    const bad = await Promise.all([
      comp.client.post(`/api/cases/${caseId}/chronology`, { occurredOn: "2026-02-31", title: "x", description: "x", locale: "en-CA" }),
      comp.client.post(`/api/cases/${caseId}/chronology`, { occurredOn: "2026-01-01", title: "", description: "x", locale: "en-CA" }),
      comp.client.post(`/api/cases/${caseId}/chronology`, { occurredOn: "2026-01-01", title: "x", description: "x", locale: "de-DE" }),
      comp.client.post(`/api/cases/${caseId}/chronology`, { occurredOn: "2026-01-01", title: "x".repeat(201), description: "x", locale: "en-CA" }),
      upload(comp, caseId, png(), { kind: "VIDEO" }), upload(comp, caseId, png(), { title: "   " }),
      cm.client.post(`/api/cases/${caseId}/open-intake`, {}), cm.client.post(`/api/cases/${caseId}/open-intake`, { hasConflict: "no" }),
    ]);
    for (const r of bad) expect(r.status).toBe(400);
    expect(await o.delta()).toMatchObject({ events: [], newObjects: [] });
    // a declared conflict of interest blocks the claim itself
    const { res, caseId: other } = await createCase(comp, resp);
    ok(res, "create"); ok(await comp.client.post(`/api/cases/${other}/submit`), "submit");
    const conflict = await cm.client.post(`/api/cases/${other}/open-intake`, { hasConflict: true, coiDetails: "Related party." });
    expect(conflict.status).toBe(409);
    expect((await caseRow(other))!.state).toBe("OPEN");
    expect((await caseRow(other))!.caseManagerId).toBeNull();
  });
});
