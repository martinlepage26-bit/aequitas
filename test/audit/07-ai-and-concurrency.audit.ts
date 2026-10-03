import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cfg, sleep } from "./lib/config";
import { setSuite, type Res } from "./lib/http";
import { observe } from "./lib/evidence";
import { assertAuditDatabase, caseEvents, caseRow, closePool, holdCaseLock, one, q, waitFor } from "./lib/db";
import { createCase, driveCase, makeAccount, makeCast, makeManager, ok, statementId, upload, type Cast } from "./lib/world";
import { legality, verifyChain } from "./lib/chain";
import { eicar, png, text } from "./lib/files";
import { stub } from "./lib/stub";

/**
 * Area 6: AI drafting (provider MOCKED by the audit stub — no real model is ever called) and concurrency.
 * The SDK's own ~10 minute request timeout cannot be exercised in a test run; provider hangs are simulated with held and dropped connections.
 */
const infra = (...args: string[]) => promisify(execFile)(process.env.AUDIT_INFRA ?? "", args, { env: process.env, timeout: 180_000 });
let cast: Cast;
beforeAll(async () => { setSuite("07-ai-and-concurrency"); cast = await makeCast("ai"); });
afterAll(async () => { await closePool(); });
beforeEach(async () => { await stub.reset(); });

const types = async (id: string) => (await caseEvents(id)).map((e) => e.type);
const recs = (id: string) => q<{ version: number; status: string; id: string }>(`select id,version,status from "Recommendation" where "caseId"=$1 order by version`, [id]);
const draftRequest = (id: string, who = cast.cm) => who.client.post(`/api/cases/${id}/draft-requests`);
const positionsCase = async () => (await driveCase(cast, "POSITIONS")).caseId;
const age = async (id: string, minutes: number) => { await assertAuditDatabase(); await q(`update "Case" set "draftRequestedAt" = now() - ($2 || ' minutes')::interval where id=$1`, [id, String(minutes)]); };
const expectConsistent = async (id: string) => { const ev = await caseEvents(id); expect(verifyChain(ev)).toEqual([]); expect(legality(ev).issues).toEqual([]); };

describe("provider outcomes: every failure leaves the case recoverable", () => {
  type Row = [mode: string, calls: number, opts?: Record<string, unknown>];
  const failures: Row[] = [["invalid_json", 1], ["missing_field", 1], ["bad_citation", 1], ["bad_excerpt", 1], ["forbidden_term", 1], ["percentage", 1], ["truncated", 1], ["refusal", 1], ["empty", 1], ["http400", 1], ["http401", 1], ["http500", 2], ["http429", 2], ["http529", 2], ["drop", 2]];
  for (const [mode, calls, opts] of failures) {
    it(`${mode}: 502 with a plain message; the case returns to POSITIONS with a DRAFT_FAILED event; no recommendation; an immediate retry succeeds`, async () => {
      const id = await positionsCase();
      await stub.control("anthropic", mode, opts);
      const res = await draftRequest(id);
      expect(res.status, res.text).toBe(502);
      expect(res.json.state).toBe("POSITIONS");
      expect(res.text, "no provider URL, key or stack in the client message").not.toMatch(/127\.0\.0\.1|4581|sk-ant|stub-model|at .*\.js:|node_modules/);
      expect((await stub.log("anthropic")).length, `provider calls for ${mode}`).toBe(calls);
      expect(await caseRow(id)).toMatchObject({ state: "POSITIONS", draftRequestId: null, draftRequestedAt: null, currentRecommendationId: null });
      expect(await recs(id)).toEqual([]);
      const events = await caseEvents(id);
      expect(events.slice(-2).map((e) => e.type)).toEqual(["RECOMMENDATION_DRAFT_REQUESTED", "RECOMMENDATION_DRAFT_FAILED"]);
      expect(events.at(-1)!.payload).toMatchObject({ toState: "POSITIONS", reason: "draft_unavailable" });
      await expectConsistent(id);
      observe("07-ai-and-concurrency", `failure-${mode}`, { status: res.status, message: res.json.message, calls: (await stub.log("anthropic")).length });
      await stub.reset();
      ok(await draftRequest(id), "retry");
      expect(await recs(id)).toMatchObject([{ version: 1, status: "DRAFT" }]);
    });
  }
  it("a code-fenced JSON answer is accepted; a transient 500 followed by a good answer succeeds through the SDK's own retry", async () => {
    const a = await positionsCase();
    await stub.control("anthropic", "ok_codefence");
    ok(await draftRequest(a), "fenced");
    const b = await positionsCase();
    await stub.reset();
    await stub.queue("anthropic", [{ mode: "http500" }, { mode: "ok" }]);
    ok(await draftRequest(b), "transient");
    expect((await stub.log("anthropic")).length).toBe(2);
    expect(await types(b)).not.toContain("RECOMMENDATION_DRAFT_FAILED");
  });
  it("the prompt carries only CLEAN evidence, both positions and the chronology, and no personal identifiers", async () => {
    const { comp, resp, cm } = cast;
    const created = await createCase(comp, resp); ok(created.res, "create"); const id = created.caseId;
    ok(await comp.client.post(`/api/cases/${id}/submit`), "submit"); ok(await cm.client.post(`/api/cases/${id}/open-intake`, { hasConflict: false }), "open");
    ok(await upload(comp, id, png(), { title: "CLEAN-COMP" }), "c"); ok(await upload(resp, id, text(), { title: "CLEAN-RESP" }), "r"); await upload(resp, id, eicar(), { title: "INFECTED-ONE" });
    ok(await comp.client.post(`/api/cases/${id}/chronology`, { occurredOn: "2026-01-02", title: "CHRONO-MARKER", description: "d", locale: "en-CA" }), "chron", 201);
    ok(await cm.client.post(`/api/cases/${id}/close-intake`, {}), "close intake");
    ok(await comp.client.post(`/api/cases/${id}/positions`, { body: "POSITION-C" }), "pc"); ok(await resp.client.post(`/api/cases/${id}/positions`, { body: "POSITION-R" }), "pr");
    ok(await draftRequest(id), "draft");
    const [call] = await stub.log("anthropic");
    expect(call.userPrompt).toContain("CLEAN-COMP"); expect(call.userPrompt).toContain("CLEAN-RESP"); expect(call.userPrompt).toContain("CHRONO-MARKER");
    expect(call.userPrompt).toContain("POSITION-C"); expect(call.userPrompt).toContain("POSITION-R");
    expect(call.userPrompt, "an infected upload must never reach the model").not.toContain("INFECTED-ONE");
    for (const secret of [comp.email, resp.email, cm.email, comp.userId, resp.userId, cm.userId, cm.name]) expect(call.userPrompt).not.toContain(secret);
    expect(call.model).toBe("stub-model-1");
    expect(call.apiKeyHeaderPresent).toBe(true);
  });
});

describe("redrafting and new versions", () => {
  it("a failed redraft keeps the existing draft as current; a successful one supersedes it", async () => {
    const id = (await driveCase(cast, "DRAFTING")).caseId;
    const [v1] = await recs(id);
    await stub.control("anthropic", "invalid_json");
    const failed = await draftRequest(id);
    expect(failed.status).toBe(502);
    expect(await caseRow(id)).toMatchObject({ state: "DRAFTING", draftRequestId: null, currentRecommendationId: v1.id });
    expect((await caseEvents(id)).at(-1)!.payload).toMatchObject({ toState: "DRAFTING" });
    expect((await cast.cm.client.get(`/api/cases/${id}/draft`)).json.id).toBe(v1.id);
    await stub.control("anthropic", "ok");
    ok(await draftRequest(id), "redraft");
    expect(await recs(id)).toMatchObject([{ version: 1, status: "SUPERSEDED" }, { version: 2, status: "DRAFT" }]);
    await expectConsistent(id);
  });
  it("a failed NEW VERSION request must not destroy the issued recommendation the parties are acting on", async () => {
    const id = (await driveCase(cast, "ISSUED")).caseId;
    const [issued] = await recs(id);
    await stub.control("anthropic", "http500", { noRetry: true });
    const res = await draftRequest(id);
    const row = await caseRow(id);
    const after = await recs(id);
    observe("07-ai-and-concurrency", "failed-new-version", { status: res.status, stateAfter: row!.state, currentRecommendationIsIssued: row!.currentRecommendationId === issued.id, statuses: after.map((r) => r.status) });
    expect(res.status).toBe(502);
    expect(row!.state, "AI outage during a redraft request must not push an ISSUED case back to POSITIONS").toBe("ISSUED");
    expect(row!.currentRecommendationId).toBe(issued.id);
    expect(after.find((r) => r.id === issued.id)!.status).toBe("ISSUED");
  });
});

describe("simultaneous, stale and expired draft requests", () => {
  it("two simultaneous requests: exactly one generates a draft, the other is refused with 409, and the provider is called once", async () => {
    const id = await positionsCase();
    await stub.control("anthropic", "delay", { ms: 1500, then: "ok" });
    const [a, b] = await Promise.all([draftRequest(id), draftRequest(id)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect((await stub.log("anthropic")).length).toBe(1);
    expect(await recs(id)).toMatchObject([{ version: 1, status: "DRAFT" }]);
    expect((await types(id)).filter((t) => t === "RECOMMENDATION_DRAFT_REQUESTED")).toHaveLength(1);
    await expectConsistent(id);
  });
  it("a late SUCCESS from an expired request cannot overwrite the newer draft", async () => {
    const id = await positionsCase();
    await stub.control("anthropic", "hold");
    const slow = draftRequest(id); // request A: provider holds the connection
    await waitFor(async () => (await stub.pending()).length === 1);
    expect((await draftRequest(id)).status, "a second request inside the 15-minute window is refused").toBe(409);
    await age(id, 16);
    await stub.control("anthropic", "ok");
    const newer = await draftRequest(id); // request B after expiry
    expect(newer.status, newer.text).toBe(200);
    const winner = await recs(id);
    await stub.release("ok"); // A finally completes successfully
    const late = await slow;
    observe("07-ai-and-concurrency", "stale-success", { lateStatus: late.status, lateBody: late.text.slice(0, 100) });
    expect(late.status).toBeGreaterThanOrEqual(400);
    expect(await recs(id)).toEqual(winner); // still exactly B's draft
    expect((await caseRow(id))!.currentRecommendationId).toBe(winner[0].id);
    expect((await types(id)).filter((t) => t === "RECOMMENDATION_DRAFTED")).toHaveLength(1);
    await expectConsistent(id);
  });
  it("a late FAILURE from an expired request cannot revert a newer successful draft", async () => {
    const id = await positionsCase();
    await stub.control("anthropic", "hold");
    const slow = draftRequest(id);
    await waitFor(async () => (await stub.pending()).length === 1);
    await age(id, 16);
    await stub.control("anthropic", "ok");
    ok(await draftRequest(id), "newer");
    const winner = await recs(id);
    await stub.release("http500", { noRetry: true });
    const late = await slow;
    expect(late.status).toBe(502);
    expect(await caseRow(id)).toMatchObject({ state: "DRAFTING", currentRecommendationId: winner[0].id });
    expect(await recs(id)).toEqual(winner);
    expect(await types(id)).not.toContain("RECOMMENDATION_DRAFT_FAILED");
    await expectConsistent(id);
  });
  it("expiry boundary: 14 minutes old is still protected (409), 16 minutes old can be retried", async () => {
    const id = await positionsCase();
    await stub.control("anthropic", "hold");
    const first = draftRequest(id);
    await waitFor(async () => (await stub.pending()).length === 1);
    await age(id, 14);
    expect((await draftRequest(id)).status).toBe(409);
    await age(id, 16);
    await stub.control("anthropic", "ok");
    expect((await draftRequest(id)).status).toBe(200);
    await stub.release("ok"); await first;
    await expectConsistent(id);
  });
  it("a server crash mid-draft leaves a recoverable request: blocked for 15 minutes, retryable afterwards", async () => {
    const id = await positionsCase();
    await stub.control("anthropic", "hold");
    const orphaned = draftRequest(id).catch((e: Error) => ({ status: -1, text: e.message }));
    await waitFor(async () => (await stub.pending()).length === 1);
    await infra("server-kill");
    await orphaned;
    await infra("server-start", cfg.storage, "on");
    const stuck = await caseRow(id);
    expect(stuck).toMatchObject({ state: "DRAFTING", currentRecommendationId: null });
    expect(stuck!.draftRequestId).toBeTruthy();
    const { cm } = cast;
    // sessions are stateless cookies, so the manager's cookie still works on the restarted server
    await stub.reset();
    expect((await cm.client.post(`/api/cases/${id}/draft-requests`)).status, "inside the window").toBe(409);
    await age(id, 16);
    await stub.control("anthropic", "ok");
    expect((await cm.client.post(`/api/cases/${id}/draft-requests`)).status).toBe(200);
    expect(await recs(id)).toMatchObject([{ version: 1, status: "DRAFT" }]);
    expect((await types(id)).filter((t) => t === "RECOMMENDATION_DRAFT_REQUESTED")).toHaveLength(2);
    await expectConsistent(id);
  });
  it("reviewing and issuing at the same instant: exactly one wins and the record stays consistent", async () => {
    const id = (await driveCase(cast, "DRAFTING")).caseId;
    const current = (await caseRow(id))!.currentRecommendationId as string;
    const draft = await cast.cm.client.get(`/api/cases/${id}/draft`);
    const edited = { ...draft.json.explanation, summary: "Raced correction." };
    for (const k of ["model", "reviewer", "knowledge_sources"]) delete edited[k];
    const lock = await holdCaseLock(id);
    let review: Promise<Res>, issue: Promise<Res>;
    try {
      review = cast.cm.client.patch(`/api/cases/${id}/draft`, { recommendationId: current, explanation: edited, reason: "race" });
      await sleep(400);
      issue = cast.cm.client.post(`/api/recommendations/${current}/issue`, { checklist: { reviewedEvidence: true, confirmedLimits: true, acceptsResponsibility: true } });
      await sleep(400);
    } finally { await lock.release(); }
    const [r, i] = [await review!, await issue!];
    observe("07-ai-and-concurrency", "review-vs-issue", { review: r.status, issue: i.status });
    expect([r.status, i.status].filter((s) => s === 200)).toHaveLength(1);
    expect([r.status, i.status].filter((s) => s === 409)).toHaveLength(1);
    const state = (await caseRow(id))!.state;
    const statuses = (await recs(id)).map((x) => x.status);
    expect(state === "ISSUED" ? statuses.filter((s) => s === "ISSUED").length === 1 : statuses.every((s) => s !== "ISSUED")).toBe(true);
    await expectConsistent(id);
  });
  it("issuing twice at the same instant issues once and notifies each party once", async () => {
    const id = (await driveCase(cast, "DRAFTING")).caseId;
    const current = (await caseRow(id))!.currentRecommendationId as string;
    const body = { checklist: { reviewedEvidence: true, confirmedLimits: true, acceptsResponsibility: true } };
    const lock = await holdCaseLock(id);
    let a: Promise<Res>, b: Promise<Res>;
    try { a = cast.cm.client.post(`/api/recommendations/${current}/issue`, body); await sleep(300); b = cast.cm.client.post(`/api/recommendations/${current}/issue`, body); await sleep(300); } finally { await lock.release(); }
    const [x, y] = [await a!, await b!];
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    expect((await types(id)).filter((t) => t === "RECOMMENDATION_ISSUED")).toHaveLength(1);
    expect(Number((await one<{ n: string }>(`select count(*) n from "Notification" where "caseId"=$1 and kind='recommendation_issued'`, [id]))!.n)).toBe(2);
  });
});

describe("lifecycle races: a guard checked before the write must still hold when the write happens", () => {
  /** Holds the case row so both requests pass their pre-checks, then lets their write transactions run together. */
  async function raced(id: string, first: () => Promise<Res>, second: () => Promise<Res>) {
    const lock = await holdCaseLock(id);
    let a: Promise<Res>, b: Promise<Res>;
    try { a = first(); await sleep(450); b = second(); await sleep(450); } finally { await lock.release(); }
    return [await a!, await b!] as const;
  }
  it("submitting twice at once: one submission, one event, one notification", async () => {
    const { comp, resp } = cast;
    const { res, caseId } = await createCase(comp, resp); ok(res, "create");
    const [a, b] = await raced(caseId, () => comp.client.post(`/api/cases/${caseId}/submit`), () => comp.client.post(`/api/cases/${caseId}/submit`));
    observe("07-ai-and-concurrency", "double-submit", { statuses: [a.status, b.status], submittedEvents: (await types(caseId)).filter((t) => t === "CASE_SUBMITTED").length });
    expect((await types(caseId)).filter((t) => t === "CASE_SUBMITTED")).toHaveLength(1);
    expect([a.status, b.status].filter((s) => s === 200)).toHaveLength(1);
    await expectConsistent(caseId);
  });
  it("two case managers claiming the same unclaimed case: exactly one becomes the manager", async () => {
    const other = await makeManager(cast.admin, "ai-cm-b");
    const { comp, resp, cm } = cast;
    const { res, caseId } = await createCase(comp, resp); ok(res, "create"); ok(await comp.client.post(`/api/cases/${caseId}/submit`), "submit");
    const [a, b] = await raced(caseId, () => cm.client.post(`/api/cases/${caseId}/open-intake`, { hasConflict: false }), () => other.client.post(`/api/cases/${caseId}/open-intake`, { hasConflict: false }));
    const row = await caseRow(caseId);
    const coi = Number((await one<{ n: string }>(`select count(*) n from "CoiDeclaration" where "caseId"=$1`, [caseId]))!.n);
    observe("07-ai-and-concurrency", "double-claim", { statuses: [a.status, b.status], assignedTo: row!.caseManagerId === cm.userId ? "first" : row!.caseManagerId === other.userId ? "second" : "none", coiRows: coi, openedEvents: (await types(caseId)).filter((t) => t === "EVIDENCE_INTAKE_OPENED").length });
    expect([a.status, b.status].filter((s) => s === 200), "both managers were told they own the case").toHaveLength(1);
    expect((await types(caseId)).filter((t) => t === "EVIDENCE_INTAKE_OPENED")).toHaveLength(1);
    expect(coi).toBe(1);
    await expectConsistent(caseId);
  });
  it("closing intake twice at once: one transition", async () => {
    const { cm } = cast;
    const id = (await driveCase(cast, "EVIDENCE_INTAKE")).caseId;
    const [a, b] = await raced(id, () => cm.client.post(`/api/cases/${id}/close-intake`, { overrideReason: "x" }), () => cm.client.post(`/api/cases/${id}/close-intake`, { overrideReason: "x" }));
    observe("07-ai-and-concurrency", "double-close-intake", { statuses: [a.status, b.status] });
    expect((await types(id)).filter((t) => t === "EVIDENCE_INTAKE_CLOSED")).toHaveLength(1);
    await expectConsistent(id);
  });
  it("a withdrawal that commits first cannot be undone by a request that was already past its checks (withdraw vs close-intake)", async () => {
    const { comp, cm } = cast;
    const id = (await driveCase(cast, "EVIDENCE_INTAKE")).caseId;
    const [w, c] = await raced(id, () => comp.client.post(`/api/cases/${id}/withdraw`), () => cm.client.post(`/api/cases/${id}/close-intake`, { overrideReason: "x" }));
    const row = await caseRow(id);
    const verdict = legality(await caseEvents(id));
    observe("07-ai-and-concurrency", "withdraw-vs-close-intake", { statuses: [w.status, c.status], finalState: row!.state, events: (await types(id)).slice(-3), illegal: verdict.issues });
    expect(row!.state, "a withdrawn case must stay withdrawn").toBe("WITHDRAWN");
    expect(verdict.issues).toEqual([]);
  });
  it("a withdrawal cannot be undone by a request that submits a draft case (withdraw vs submit)", async () => {
    const { comp, resp } = cast;
    const { res, caseId } = await createCase(comp, resp); ok(res, "create");
    const [w, s] = await raced(caseId, () => comp.client.post(`/api/cases/${caseId}/withdraw`), () => comp.client.post(`/api/cases/${caseId}/submit`));
    const row = await caseRow(caseId);
    observe("07-ai-and-concurrency", "withdraw-vs-submit", { statuses: [w.status, s.status], finalState: row!.state, illegal: legality(await caseEvents(caseId)).issues });
    expect(row!.state).toBe("WITHDRAWN");
    expect(legality(await caseEvents(caseId)).issues).toEqual([]);
  });
  it("both parties consenting at the same instant: both requests succeed and the case resolves (no 500, no lost 'both consented')", async () => {
    const { comp, resp } = cast;
    const sid = await statementId();
    const problems: string[] = [], statusPairs: number[][] = [];
    for (let i = 0; i < 8; i++) {
      const id = (await driveCase(cast, "ISSUED")).caseId;
      const [a, b] = await raced(id, () => comp.client.post(`/api/cases/${id}/consent`, { action: "give", statementVersionId: sid }), () => resp.client.post(`/api/cases/${id}/consent`, { action: "give", statementVersionId: sid }));
      statusPairs.push([a.status, b.status]);
      const given = Number((await one<{ n: string }>(`select count(*) n from "ConsentRecord" where "caseId"=$1 and state='GIVEN'`, [id]))!.n);
      const state = (await caseRow(id))!.state as string;
      if (a.status >= 500 || b.status >= 500) problems.push(`${id}: HTTP ${a.status}/${b.status}, ${given} consent(s) recorded, state ${state}`);
      else if (given === 2 && state !== "RESOLVED_CONSENT") problems.push(`${id}: ${given} consents GIVEN but state ${state}`);
    }
    observe("07-ai-and-concurrency", "simultaneous-consent", { iterations: 8, statusPairs, problems: problems.length });
    expect(problems, problems.join("\n")).toEqual([]);
  });
  it("one party submitting two positions at once gets distinct, ordered versions", async () => {
    const { comp } = cast;
    const id = await positionsCase();
    const [a, b] = await raced(id, () => comp.client.post(`/api/cases/${id}/positions`, { body: "second A" }), () => comp.client.post(`/api/cases/${id}/positions`, { body: "second B" }));
    const versions = (await q<{ version: number }>(`select version from "PositionStatement" where "caseId"=$1 and "partyId"=$2 order by "createdAt"`, [id, comp.userId])).map((r) => r.version);
    observe("07-ai-and-concurrency", "double-position", { statuses: [a.status, b.status], versions });
    expect([a.status, b.status].every((x) => x < 500), `HTTP ${a.status}/${b.status}`).toBe(true);
    expect(new Set(versions).size, `versions ${versions}`).toBe(versions.length);
  });
  it("revoking consent while the case is being closed cannot leave a CLOSED case with a revoked consent (revoke vs close)", async () => {
    const { resp, cm } = cast;
    const id = (await driveCase(cast, "RESOLVED_CONSENT")).caseId;
    await assertAuditDatabase();
    // Make the closing transaction slow (3 s inside the event append) so the revoke request is definitely issued while it is in flight.
    await q(`CREATE OR REPLACE FUNCTION audit_slow_event() RETURNS trigger AS $$ BEGIN IF NEW."caseId"='${id}' AND NEW.type='EXPORT_GENERATED' THEN PERFORM pg_sleep(3); END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
    await q(`CREATE TRIGGER audit_slow_event BEFORE INSERT ON "Event" FOR EACH ROW EXECUTE FUNCTION audit_slow_event()`);
    let cl: Res, rv: Res;
    try {
      const closing = cm.client.post(`/api/cases/${id}/close`);
      await waitFor(async () => Number((await one<{ n: string }>(`select count(*) n from "ExportBundle" where "caseId"=$1`, [id]))!.n) > 0, 60_000); // archive recorded: closeCase is next
      await sleep(900);
      rv = await resp.client.post(`/api/cases/${id}/consent`, { action: "revoke" });
      cl = await closing;
    } finally { await q(`DROP TRIGGER IF EXISTS audit_slow_event ON "Event"`); await q(`DROP FUNCTION IF EXISTS audit_slow_event()`); }
    const row = await caseRow(id);
    const verdict = legality(await caseEvents(id));
    const revoked = Number((await one<{ n: string }>(`select count(*) n from "ConsentRecord" where "caseId"=$1 and state='REVOKED'`, [id]))!.n);
    observe("07-ai-and-concurrency", "revoke-vs-close", { statuses: [rv.status, cl.status], finalState: row!.state, closedAt: row!.closedAt, revokedConsents: revoked, illegal: verdict.issues, events: (await types(id)).slice(-5) });
    expect(row!.state === "CLOSED" ? revoked : 0, "a closed case certifies mutual consent: no consent may be revoked").toBe(0);
    expect(verdict.issues, "events in an order the state machine forbids").toEqual([]);
    expect(row!.state, "a case that was closed must not be reopened by a request that began earlier").not.toBe("ISSUED");
  });
});
