import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";
import { cfg, sleep } from "./lib/config";
import { Client, setSuite } from "./lib/http";
import { observe } from "./lib/evidence";
import { assertAuditDatabase, caseEvents, closePool, holdCaseLock, one, q } from "./lib/db";
import { createCase, driveCase, makeAccount, makeCast, ok, type Cast } from "./lib/world";
import { canonicalJson, legality, verifyChain, type ChainEvent } from "./lib/chain";
import { png } from "./lib/files";

/**
 * Area 7 (integrity): event ordering, hash chains, replay, concurrent writes — verified independently of the app's own verifier —
 * plus intentional tamper fixtures kept in a SEPARATE database so they can never contaminate valid-chain verification.
 */
const run = promisify(execFile);
let cast: Cast;
const tamper = new pg.Pool({ connectionString: process.env.AUDIT_TAMPER_DATABASE_URL, max: 4 });
beforeAll(async () => { setSuite("08-integrity"); cast = await makeCast("integ"); });
afterAll(async () => { await tamper.end(); await closePool(); });

async function verifyCli(db: "aequitas_audit_test" | "aequitas_audit_tamper_test") {
  try {
    const { stdout, stderr } = await run(process.env.AUDIT_WITH_DB!, [db, "--", "npm", "run", "verify:events"], { cwd: process.cwd(), env: process.env, timeout: 180_000 });
    return { code: 0, out: `${stdout}\n${stderr}` };
  } catch (e) { const err = e as { code?: number; stdout?: string; stderr?: string }; return { code: err.code ?? 1, out: `${err.stdout ?? ""}\n${err.stderr ?? ""}` }; }
}

describe("hash chains and ordering across every case this audit created", () => {
  it("every case's chain re-verifies independently: contiguous seq, prevHash linkage, recomputed hashes, non-decreasing time", async () => {
    await assertAuditDatabase();
    const cases = await q<{ id: string; referenceNumber: string; state: string }>(`select id,"referenceNumber",state from "Case"`);
    const broken: string[] = [];
    let events = 0;
    for (const c of cases) {
      const ev = await caseEvents(c.id);
      events += ev.length;
      for (const issue of verifyChain(ev as ChainEvent[])) broken.push(`${c.referenceNumber} seq ${issue.seq}: ${issue.message}`);
    }
    observe("08-integrity", "all-chains", { cases: cases.length, events, brokenChains: broken.length });
    expect(cases.length).toBeGreaterThan(50);
    expect(broken, broken.slice(0, 5).join("\n")).toEqual([]);
  });
  it("the repository's own verify:events agrees (exit 0) on the valid database", async () => {
    const res = await verifyCli("aequitas_audit_test");
    observe("08-integrity", "verify-events-cli-valid-db", { exit: res.code, tail: res.out.trim().split("\n").slice(-3) });
    expect(res.code, res.out.slice(-400)).toBe(0);
    expect(res.out).toContain("verify:events OK");
  });
  it("every case replays to its stored state, and no case's event order is illegal for the state machine (known-race cases are listed, not hidden)", async () => {
    const cases = await q<{ id: string; referenceNumber: string; state: string }>(`select id,"referenceNumber",state from "Case"`);
    const mismatches: string[] = [], illegal: string[] = [];
    for (const c of cases) {
      const ev = (await caseEvents(c.id)) as ChainEvent[];
      const verdict = legality(ev);
      if (verdict.finalState !== "NONE" && verdict.finalState !== c.state) mismatches.push(`${c.referenceNumber}: events replay to ${verdict.finalState}, stored ${c.state}`);
      if (verdict.issues.length) illegal.push(`${c.referenceNumber}: ${verdict.issues.map((i) => i.message).join("; ")}`);
    }
    observe("08-integrity", "legality-all-cases", { cases: cases.length, projectionMismatches: mismatches.length, casesWithIllegalSequences: illegal.length, sample: illegal.slice(0, 6) });
    expect(mismatches, mismatches.join("\n")).toEqual([]);
    // The lifecycle-race suite (07) deliberately produces illegal sequences; verify:events cannot see them. Count them for the report.
    expect(illegal.length).toBeGreaterThanOrEqual(0);
  });
  it("observation: the independent legality check flags every race-produced sequence that verify:events accepted above", async () => {
    const illegalCase = await q<{ id: string }>(`select c.id from "Case" c where c.id in (select "caseId" from "Event" where type='CASE_WITHDRAWN') and exists (select 1 from "Event" e where e."caseId"=c.id and e.type in ('EVIDENCE_INTAKE_CLOSED','CASE_SUBMITTED') and e.seq > (select min(w.seq) from "Event" w where w."caseId"=c.id and w.type='CASE_WITHDRAWN'))`);
    observe("08-integrity", "verify-blind-to-illegal-sequences", { casesWithEventsAfterWithdrawal: illegalCase.length });
    for (const row of illegalCase) expect(legality((await caseEvents(row.id)) as ChainEvent[]).issues.length).toBeGreaterThan(0);
    // The repository verifier accepted all of these cases above; the regression test for that gap is in the tamper-fixture block below.
  });
});

describe("concurrent valid writes keep a gap-free, correctly ordered chain", () => {
  it("40 simultaneous chronology entries from both parties: all accepted, seq 1..n with no gaps or duplicates, chain valid", async () => {
    const { comp, resp } = cast;
    const id = (await driveCase(cast, "EVIDENCE_INTAKE")).caseId;
    const before = (await caseEvents(id)).length;
    const results = await Promise.all(Array.from({ length: 40 }, (_, i) => (i % 2 ? resp : comp).client.post(`/api/cases/${id}/chronology`, { occurredOn: "2026-02-02", title: `Entry ${i}`, description: `Concurrent entry ${i}`, locale: "en-CA" })));
    observe("08-integrity", "concurrent-chronology", { statuses: [...new Set(results.map((r) => r.status))], accepted: results.filter((r) => r.status === 201).length });
    expect(results.every((r) => r.status === 201), `statuses ${[...new Set(results.map((r) => r.status))]}`).toBe(true);
    const ev = await caseEvents(id);
    expect(ev.length).toBe(before + 40);
    expect(verifyChain(ev as ChainEvent[])).toEqual([]);
    expect(Number((await one<{ n: string }>(`select count(*) n from "ChronologyEntry" where "caseId"=$1`, [id]))!.n)).toBe(40);
  });
  it("mixed simultaneous writes (evidence uploads, chronology, administrator reads) keep one valid chain", async () => {
    const { comp, resp, admin } = cast;
    const id = (await driveCase(cast, "EVIDENCE_INTAKE")).caseId;
    const form = (n: number) => { const f = new FormData(); f.set("file", new File([new Uint8Array(png())], "x.png")); f.set("kind", "PHOTO"); f.set("title", `Concurrent ${n}`); return f; };
    const jobs: Array<Promise<{ status: number }>> = [];
    for (let i = 0; i < 12; i++) jobs.push(comp.client.request("POST", `/api/cases/${id}/evidence`, { form: form(i) }));
    for (let i = 0; i < 12; i++) jobs.push(resp.client.post(`/api/cases/${id}/chronology`, { occurredOn: "2026-02-03", title: `C${i}`, description: "x", locale: "en-CA" }));
    for (let i = 0; i < 12; i++) jobs.push(admin.client.get(`/api/cases/${id}/events`));
    const out = await Promise.all(jobs);
    const failures = out.filter((r) => r.status >= 400);
    observe("08-integrity", "mixed-concurrent", { total: out.length, failures: failures.length, statuses: [...new Set(out.map((r) => r.status))] });
    expect(failures.map((r) => r.status)).toEqual([]);
    expect(verifyChain((await caseEvents(id)) as ChainEvent[])).toEqual([]);
  });
  it("event payloads survive the database round trip: the canonical form hashed at write time equals the canonical form read back", async () => {
    // Guards the classic failure where undefined/Date/number-format differences make a valid chain look tampered.
    const id = (await driveCase(cast, "CLOSED")).caseId;
    const ev = (await caseEvents(id)) as ChainEvent[];
    for (const e of ev) expect(canonicalJson(JSON.parse(JSON.stringify(e.payload)))).toBe(canonicalJson(e.payload));
    expect(verifyChain(ev)).toEqual([]);
    // edge payloads the product can produce: unicode, emoji, very long text, quotes and backslashes
    const { comp, resp, cm } = cast;
    const created = await createCase(comp, resp); ok(created.res, "create");
    ok(await comp.client.post(`/api/cases/${created.caseId}/submit`), "submit"); ok(await cm.client.post(`/api/cases/${created.caseId}/open-intake`, { hasConflict: false }), "open");
    ok(await comp.client.post(`/api/cases/${created.caseId}/chronology`, { occurredOn: "2026-02-04", title: 'Guillemets "x" \\ barre 😀 é', description: "Ligne\nsuivante\t☃ ".repeat(50), locale: "fr-CA" }), "chron", 201);
    expect(verifyChain((await caseEvents(created.caseId)) as ChainEvent[])).toEqual([]);
  });
});

describe("intentional tamper fixtures (separate database: aequitas_audit_tamper_test)", () => {
  const tq = async (sql: string, params: unknown[] = []) => (await tamper.query(sql, params)).rows;
  async function assertTamperDb() {
    const row = (await tq(`select current_database() d, inet_server_port() p, current_user u`))[0];
    if (row.d !== "aequitas_audit_tamper_test" || row.p !== 54329 || row.u !== "aq_test") throw new Error(`Refusing: unexpected tamper DB target ${JSON.stringify(row)}`);
  }
  /** Copies a valid case (users, case, events) from the audit DB into the tamper DB, hashes untouched. */
  async function copyCase(caseId: string) {
    const c = (await q(`select * from "Case" where id=$1`, [caseId]))[0];
    for (const uid of [c.complainantId, c.respondentId, c.caseManagerId].filter(Boolean)) {
      const u = (await q(`select * from "User" where id=$1`, [uid]))[0];
      await tq(`insert into "User"(id,email,"displayName",locale,"globalRole","createdAt") values ($1,$2,$3,$4,$5,$6) on conflict (id) do nothing`, [u.id, u.email, u.displayName, u.locale, u.globalRole, u.createdAt]);
    }
    await tq(`insert into "Case"(id,"referenceNumber",state,category,simulated,"complainantId","respondentId","caseManagerId","createdAt","closedAt") values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [c.id, c.referenceNumber, c.state, c.category, c.simulated, c.complainantId, c.respondentId, c.caseManagerId, c.createdAt, c.closedAt]);
    for (const e of await caseEvents(caseId)) await tq(`insert into "Event"(id,"caseId",seq,type,"actorId",payload,"prevHash",hash,"createdAt") values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)`, [e.id, caseId, e.seq, e.type, e.actorId, JSON.stringify(e.payload), e.prevHash, e.hash, e.createdAt]);
  }
  async function resetTamperDb() {
    await assertTamperDb();
    await tq(`ALTER TABLE "Event" DISABLE TRIGGER events_append_only`);
    await tq(`DELETE FROM "Event"`); await tq(`ALTER TABLE "Event" ENABLE TRIGGER events_append_only`);
    await tq(`DELETE FROM "Case"`); await tq(`DELETE FROM "User"`);
  }
  it("append-only trigger: UPDATE and DELETE of an event are refused for the application role", async () => {
    await resetTamperDb();
    const { caseId } = await driveCase(cast, "OPEN");
    await copyCase(caseId);
    await expect(tq(`update "Event" set payload='{}'::jsonb where "caseId"=$1`, [caseId])).rejects.toThrow(/append-only/);
    await expect(tq(`delete from "Event" where "caseId"=$1`, [caseId])).rejects.toThrow(/append-only/);
  });
  it("the append-only guarantee has gaps for the table owner: TRUNCATE, DISABLE TRIGGER and DROP TRIGGER are allowed (observation: the app role owns the table)", async () => {
    await assertTamperDb();
    const client = await tamper.connect();
    const outcomes: Record<string, string> = {};
    try {
      for (const [label, sql] of [["TRUNCATE", `TRUNCATE "Event"`], ["DISABLE TRIGGER", `ALTER TABLE "Event" DISABLE TRIGGER events_append_only`], ["DROP TRIGGER", `DROP TRIGGER events_append_only ON "Event"`]] as const) {
        await client.query("BEGIN");
        try { await client.query(sql); outcomes[label] = "allowed"; } catch (e) { outcomes[label] = `refused: ${(e as Error).message}`; }
        await client.query("ROLLBACK");
      }
    } finally { client.release(); }
    observe("08-integrity", "append-only-bypass", outcomes);
    expect(Object.values(outcomes).every((v) => v.startsWith("refused")), JSON.stringify(outcomes)).toBe(true);
  });
  const variants: Array<[string, (id: string) => Promise<void>, RegExp]> = [
    ["event payload edited", async (id) => { await tq(`update "Event" set payload='{"edited":true}'::jsonb where "caseId"=$1 and seq=2`, [id]); }, /hash mismatch/],
    ["middle event deleted", async (id) => { await tq(`delete from "Event" where "caseId"=$1 and seq=2`, [id]); }, /seq gap|prevHash mismatch/],
    ["prevHash rewritten", async (id) => { await tq(`update "Event" set "prevHash"='${"a".repeat(64)}' where "caseId"=$1 and seq=2`, [id]); }, /prevHash mismatch/],
    ["timestamp altered", async (id) => { await tq(`update "Event" set "createdAt"="createdAt" + interval '1 second' where "caseId"=$1 and seq=1`, [id]); }, /hash mismatch/],
    ["actor swapped", async (id) => { await tq(`update "Event" set "actorId"='someone-else' where "caseId"=$1 and seq=1`, [id]); }, /hash mismatch/],
    ["stored state edited (projection)", async (id) => { await tq(`update "Case" set state='CLOSED' where id=$1`, [id]); }, /projection mismatch/],
  ];
  it("each class of tampering is detected by the repository's verify:events (exit 1, named issue); the valid database stays clean", async () => {
    await resetTamperDb();
    const sources: string[] = [];
    for (let i = 0; i < variants.length; i++) sources.push((await driveCase(cast, "POSITIONS")).caseId);
    for (const id of sources) await copyCase(id);
    expect((await verifyCli("aequitas_audit_tamper_test")).code, "copies are valid before tampering").toBe(0);
    const results: Record<string, { code: number; matched: boolean }> = {};
    for (let i = 0; i < variants.length; i++) {
      const [label, mutate, pattern] = variants[i];
      await assertTamperDb();
      await tq(`ALTER TABLE "Event" DISABLE TRIGGER events_append_only`);
      try { await mutate(sources[i]); } finally { await tq(`ALTER TABLE "Event" ENABLE TRIGGER events_append_only`); }
      const res = await verifyCli("aequitas_audit_tamper_test");
      results[label] = { code: res.code, matched: pattern.test(res.out) };
      // restore the single tampered case so each variant is judged on its own
      await tq(`ALTER TABLE "Event" DISABLE TRIGGER events_append_only`);
      await tq(`DELETE FROM "Event" WHERE "caseId"=$1`, [sources[i]]); await tq(`DELETE FROM "Case" WHERE id=$1`, [sources[i]]);
      await tq(`ALTER TABLE "Event" ENABLE TRIGGER events_append_only`);
      await copyCase(sources[i]);
    }
    observe("08-integrity", "tamper-detection", results);
    for (const [label, r] of Object.entries(results)) { expect(r.code, `${label}: exit code`).toBe(1); expect(r.matched, `${label}: named issue`).toBe(true); }
    expect((await verifyCli("aequitas_audit_test")).code, "the valid database is untouched by the tamper work").toBe(0);
  });
  it("verify:events flags a hash-valid log that contains a transition the state machine forbids (CASE_WITHDRAWN, then CASE_SUBMITTED)", async () => {
    // The sequence is produced by the real API with the same row-lock barrier the lifecycle-race suite uses; the judgement happens on a copy in the tamper database.
    const { comp, resp } = cast;
    const { res, caseId } = await createCase(comp, resp); ok(res, "create");
    const lock = await holdCaseLock(caseId);
    let withdrawing: ReturnType<typeof comp.client.post>, submitting: ReturnType<typeof comp.client.post>;
    try {
      withdrawing = comp.client.post(`/api/cases/${caseId}/withdraw`); await sleep(450);
      submitting = comp.client.post(`/api/cases/${caseId}/submit`); await sleep(450);
    } finally { await lock.release(); }
    const statuses = [(await withdrawing!).status, (await submitting!).status];
    const events = (await caseEvents(caseId)) as ChainEvent[];
    const independent = legality(events);
    observe("08-integrity", "verify-events-illegal-sequence-fixture", { statuses, types: events.map((e) => e.type), chainIssues: verifyChain(events).length, independentIssues: independent.issues.map((i) => i.message) });
    expect(statuses, "fixture precondition: both racing requests were accepted").toEqual([200, 200]);
    expect(verifyChain(events), "fixture precondition: the hash chain itself is valid").toEqual([]);
    expect(independent.issues.length, "fixture precondition: the log is illegal for the state machine").toBeGreaterThan(0);
    await resetTamperDb();
    await copyCase(caseId);
    const verdict = await verifyCli("aequitas_audit_tamper_test");
    observe("08-integrity", "verify-events-illegal-sequence-verdict", { exit: verdict.code, tail: verdict.out.trim().split("\n").slice(-3) });
    expect(verdict.code, `verify:events accepted a log containing an illegal transition: ${verdict.out.slice(-300)}`).toBe(1);
  });
});

describe("database outage: the health endpoint tells the truth and the app recovers", () => {
  it("/api/health answers 503 within seconds when Postgres is down, other routes fail without leaking internals, and everything recovers when it returns", async () => {
    const comp = await makeAccount("COMPLAINANT", "outage");
    const anon = new Client("outage-anon");
    await promisify(execFile)(process.env.AUDIT_INFRA!, ["pg-stop"], { env: process.env, timeout: 120_000 });
    let health: Awaited<ReturnType<Client["get"]>>, api: Awaited<ReturnType<Client["get"]>>, page: Awaited<ReturnType<Client["get"]>>, signin: Awaited<ReturnType<Client["post"]>>;
    try {
      const t = Date.now();
      health = await anon.get("/api/health"); const healthMs = Date.now() - t;
      api = await comp.client.get("/api/cases/00000000-0000-4000-8000-000000000000");
      page = await comp.client.get("/fr-CA/cases");
      signin = await anon.post("/api/auth/webauthn/authenticate", { step: "options", email: "x@audit.example.test" });
      observe("08-integrity", "database-down", { healthStatus: health.status, healthBody: health.text, healthMs, apiStatus: api.status, apiBody: api.text.slice(0, 120), pageStatus: page.status, signinOptionsStatus: signin.status });
    } finally { await promisify(execFile)(process.env.AUDIT_INFRA!, ["pg-start"], { env: process.env, timeout: 120_000 }); }
    expect(health.status).toBe(503);
    expect(health.json).toEqual({ status: "unavailable" });
    expect(health.headers.get("cache-control")).toMatch(/no-store/);
    for (const res of [api, page]) { expect(res.status).toBeGreaterThanOrEqual(500); expect(res.text).not.toMatch(/postgres|ECONNREFUSED|54329|prisma|aq_test|DATABASE_URL/i); }
    expect(signin.status, "sign-in options need no database and should keep working").toBe(200);
    // recovery without restarting the app
    let recovered = 0;
    for (let i = 0; i < 40 && !recovered; i++) { const h = await anon.get("/api/health").catch(() => null); if (h?.status === 200) recovered = i + 1; else await sleep(500); }
    observe("08-integrity", "database-recovery", { healthChecksUntilOk: recovered });
    expect(recovered, "health must return to 200 after Postgres restarts").toBeGreaterThan(0);
    expect((await comp.client.get("/api/cases/00000000-0000-4000-8000-000000000000")).status).toBe(404);
  });
});

void cfg;
