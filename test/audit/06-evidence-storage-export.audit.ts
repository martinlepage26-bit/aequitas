import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cfg, sleep } from "./lib/config";
import { rawRequest, setSuite } from "./lib/http";
import { observe } from "./lib/evidence";
import { assertAuditDatabase, caseEvents, caseRow, closePool, holdCaseLock, one, q, waitFor } from "./lib/db";
import { createCase, driveCase, makeCast, ok, statementId, upload, type Cast } from "./lib/world";
import { eicar, evidenceForm, exe, jpeg, pdf, png, pngOfSize, text, textOfSize, unsniffable } from "./lib/files";
import { deleteObject, getObject, keysForCase, putObject } from "./lib/storage";
import { readZip } from "./lib/zip";
import { verifyChain } from "./lib/chain";
import { stub } from "./lib/stub";

/**
 * Area 5: evidence and storage against REAL ClamAV and a REAL object store (MinIO RELEASE.2025-10-15T17-29-55Z built from the
 * pinned upstream commit, or the local-disk backend: run this file once per AUDIT_STORAGE mode).
 */
// Async on purpose: a blocking child process freezes the event loop and leaves stale keep-alive sockets in the HTTP client.
const infra = (command: string) => promisify(execFile)(process.env.AUDIT_INFRA ?? "", [command], { env: process.env, timeout: 180_000 });
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const MiB = 1024 * 1024;
let cast: Cast;
beforeAll(async () => { setSuite(`06-evidence-storage-${cfg.storage}`); cast = await makeCast(`ev-${cfg.storage}`); });
afterAll(async () => { await closePool(); });

const intakeCase = async () => (await driveCase(cast, "EVIDENCE_INTAKE")).caseId;
const items = (caseId: string) => q<{ id: string; storageKey: string; sha256: string; byteSize: number; mimeType: string; scanStatus: string; title: string; submittedById: string }>(`select * from "EvidenceItem" where "caseId"=$1 order by "createdAt"`, [caseId]);
const types = async (caseId: string) => (await caseEvents(caseId)).map((e) => e.type);
async function objectDigests(caseId: string) { const out = new Map<string, string>(); for (const key of await keysForCase(caseId)) out.set(key, sha((await getObject(key))!)); return out; }

describe(`valid evidence (${cfg.storage} storage, real ClamAV)`, () => {
  const samples: Array<[string, () => Promise<Buffer> | Buffer, string]> = [["PNG image", png, "image/png"], ["JPEG image", jpeg, "image/jpeg"], ["PDF document", () => pdf(["Synthetic evidence"]), "application/pdf"], ["UTF-8 text", () => text("Texte synthétique: facture reçue le 2026-01-01 — ✓\n"), "text/plain"]];
  for (const [label, make, mime] of samples) {
    it(`${label}: accepted, scanned CLEAN, stored byte-for-byte under a server-chosen key, hash recorded`, async () => {
      const caseId = await intakeCase();
      const bytes = await make();
      const res = await upload(cast.comp, caseId, bytes, { title: `Évidence ${label} ✓`, description: "Synthetic description", kind: "DOCUMENT", filename: "n'importe quoi.bin", type: "application/octet-stream" });
      expect(res.status, res.text).toBe(200);
      const [row] = await items(caseId);
      expect(row).toMatchObject({ mimeType: mime, scanStatus: "CLEAN", byteSize: bytes.length, sha256: sha(bytes), submittedById: cast.comp.userId });
      expect(row.storageKey).toBe(`live/${caseId}/${row.id}`);
      expect((await getObject(row.storageKey))!.equals(bytes)).toBe(true);
      expect((await types(caseId)).at(-1)).toBe("EVIDENCE_SUBMITTED");
    });
  }
  it("the stored type comes from the file's contents, not from the client's claim", async () => {
    const caseId = await intakeCase();
    ok(await upload(cast.comp, caseId, png(), { title: "Lies about itself", filename: "malware.exe", type: "application/x-msdownload" }), "upload");
    expect((await items(caseId))[0].mimeType).toBe("image/png");
  });
});

describe("invalid evidence is refused before anything is stored", () => {
  it("empty, unidentifiable, missing-field and wrongly-typed submissions get 400 and leave no row, object or event", async () => {
    const caseId = await intakeCase();
    const before = { events: (await caseEvents(caseId)).length, keys: await keysForCase(caseId) };
    const form = (build: (f: FormData) => void) => { const f = new FormData(); build(f); return f; };
    const bad = await Promise.all([
      upload(cast.comp, caseId, Buffer.alloc(0), { title: "empty file" }),
      upload(cast.comp, caseId, unsniffable(), { title: "binary noise" }),
      upload(cast.comp, caseId, png(), { kind: "VIDEO" }), upload(cast.comp, caseId, png(), { title: "   " }),
      cast.comp.client.request("POST", `/api/cases/${caseId}/evidence`, { form: form((f) => { f.set("kind", "DOCUMENT"); f.set("title", "no file part"); }) }),
      cast.comp.client.request("POST", `/api/cases/${caseId}/evidence`, { form: form((f) => { f.set("file", "just a string"); f.set("kind", "DOCUMENT"); f.set("title", "string file"); }) }),
    ]);
    for (const r of bad) expect(r.status, r.text).toBe(400);
    expect((await caseEvents(caseId)).length).toBe(before.events);
    expect(await keysForCase(caseId)).toEqual(before.keys);
    expect(await items(caseId)).toEqual([]);
  });
  it("observation: file types are not allow-listed (an executable and HTML are accepted as evidence)", async () => {
    const caseId = await intakeCase();
    const outcomes: Record<string, unknown> = {};
    for (const [label, bytes] of [["exe", exe()], ["html", Buffer.from("<html><script>alert(1)</script></html>")], ["svg", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')]] as const) {
      const res = await upload(cast.comp, caseId, bytes, { title: `type probe ${label}` });
      outcomes[label] = { status: res.status };
    }
    const rows = await items(caseId);
    observe("06-evidence-storage", "no-content-type-allowlist", { outcomes, storedMimeTypes: rows.map((r) => r.mimeType), scanStatuses: rows.map((r) => r.scanStatus) });
    expect(rows.length).toBeGreaterThanOrEqual(0);
  });
  it("path-like names are inert: filename, title and description never influence the storage key", async () => {
    const caseId = await intakeCase();
    const nasty = ["../../etc/passwd", "..\\..\\windows\\system32", "/absolute/path", "a/../../b", "%2e%2e%2f", "x".repeat(300), "nul\u0000byte", "新しい文書.png"];
    const serverErrors: string[] = [];
    for (const name of nasty) {
      const res = await upload(cast.comp, caseId, png(), { title: name, description: name, filename: name });
      if (res.status >= 500) serverErrors.push(`${JSON.stringify(name.slice(0, 40))}: HTTP ${res.status}`);
    }
    // The storage-key checks run before the status assertion, so one hostile name that answers 500 (U+0000, see suite 10) cannot hide them.
    for (const row of await items(caseId)) expect(row.storageKey).toBe(`live/${caseId}/${row.id}`);
    for (const key of await keysForCase(caseId)) expect(key).toMatch(new RegExp(`^live/${caseId}/[0-9a-f-]{36}$`));
    expect(serverErrors, serverErrors.join("\n")).toEqual([]);
  });
  it("URL path traversal through the case or evidence id reaches no file and no 5xx", async () => {
    const caseId = await intakeCase();
    const probes = [`/api/cases/..%2f..%2fetc%2fpasswd/evidence`, `/api/cases/%2e%2e/evidence`, `/api/cases/${caseId}/evidence/..%2f..%2f${caseId}/supersede`, `/api/cases/${caseId}%00/export`, `/api/cases/${caseId}/evidence/%2e%2e/supersede`];
    for (const path of probes) {
      const res = await rawRequest({ method: "POST", path, headers: { cookie: cast.comp.client.header(), "content-type": "multipart/form-data; boundary=x" }, body: "--x--\r\n" });
      expect(res.status, path).toBeLessThan(500);
      expect(res.text).not.toMatch(/root:|\/etc\/passwd/);
    }
  });
});

describe("size limits (stated limit: 25 MB)", () => {
  const cases: Array<[string, number, number]> = [["1 byte", 1, 200], ["9 MiB", 9 * MiB, 200], ["11 MiB (above Next.js's default 10 MB proxy buffer)", 11 * MiB, 200], ["24 MiB", 24 * MiB, 200], ["exactly 25 MiB", 25 * MiB, 200], ["25 MiB + 1 byte", 25 * MiB + 1, 400]];
  for (const [label, size, want] of cases) {
    it(`${label}: ${want === 200 ? "accepted with full integrity" : "refused with 400"}`, async () => {
      const caseId = await intakeCase();
      const bytes = size === 1 ? text("a") : pngOfSize(size);
      const res = await upload(cast.comp, caseId, bytes, { title: `size probe ${label}` });
      const rows = await items(caseId);
      const stored = rows[0] ? await getObject(rows[0].storageKey) : null;
      observe("06-evidence-storage", `size-${size}`, { label, status: res.status, message: res.text.slice(0, 100), storedBytes: stored?.length ?? null, recordedBytes: rows[0]?.byteSize ?? null, hashMatches: stored ? sha(stored) === rows[0].sha256 && sha(bytes) === rows[0].sha256 : null });
      expect(res.status, res.text.slice(0, 160)).toBe(want);
      if (want === 200) {
        expect(rows).toHaveLength(1);
        expect(rows[0].byteSize, "recorded size must equal the uploaded size (no silent truncation)").toBe(size);
        expect(rows[0].sha256).toBe(sha(bytes));
        expect(stored!.length).toBe(size);
      } else {
        expect(rows).toHaveLength(0);
        expect(await keysForCase(caseId)).toEqual([]);
      }
    });
  }
});

describe("malware (EICAR through the real clamd)", () => {
  it("an EICAR upload is rejected: it must not be stored, listed or exported as evidence, and the uploader must be told", async () => {
    const caseId = await intakeCase();
    const res = await upload(cast.resp, caseId, eicar(), { title: "RESP-REJECTED-MARKER", kind: "OTHER" });
    const rows = await items(caseId);
    const events = await caseEvents(caseId);
    const notes = await q<{ kind: string; userId: string }>(`select kind,"userId" from "Notification" where "caseId"=$1 and kind='evidence_rejected'`, [caseId]);
    const keys = await keysForCase(caseId);
    observe("06-evidence-storage", "eicar-upload", { httpStatus: res.status, responseBody: res.text.slice(0, 120), rows: rows.map((r) => ({ scanStatus: r.scanStatus, mimeType: r.mimeType })), objectsStored: keys.length, eventPayload: events.at(-1)?.payload, rejectedNotifications: notes.length });
    expect.soft(res.status, "the HTTP response must tell the uploader the file was refused").toBeGreaterThanOrEqual(400);
    expect(keys, "infected bytes must not be persisted in the object store").toEqual([]); // soft above, so both facets are reported
  });
  it("the rejected item is invisible to the other party and to the AI, and visible (as rejected) to its submitter", async () => {
    const caseId = await intakeCase();
    await upload(cast.resp, caseId, eicar(), { title: "RESP-HIDDEN-MARKER" });
    const asComp = await cast.comp.client.get(`/fr-CA/cases/${caseId}`);
    const asResp = await cast.resp.client.get(`/fr-CA/cases/${caseId}`);
    expect(asComp.text).not.toContain("RESP-HIDDEN-MARKER");
    observe("06-evidence-storage", "rejected-item-visibility", { otherPartyPageShowsIt: asComp.text.includes("RESP-HIDDEN-MARKER"), submitterPageShowsIt: asResp.text.includes("RESP-HIDDEN-MARKER") });
  });
  it("EICAR inside a ZIP archive is detected (archives are unpacked); EICAR padded into a bigger file is not a ClamAV detection (hash signature)", async () => {
    const caseId = await intakeCase();
    const padded = Buffer.concat([png(), Buffer.alloc(10_000, 0x41), eicar(), Buffer.alloc(10_000, 0x42)]);
    const dir = mkdtempSync(join(tmpdir(), "audit-zip-"));
    writeFileSync(join(dir, "eicar.com"), eicar());
    execFileSync("python3", ["-c", "import zipfile,sys;z=zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED);z.write(sys.argv[2],'eicar.com');z.close()", join(dir, "a.zip"), join(dir, "eicar.com")]);
    const zipBytes = readFileSync(join(dir, "a.zip"));
    rmSync(dir, { recursive: true, force: true });
    await upload(cast.comp, caseId, zipBytes, { title: "zip with eicar" });
    await upload(cast.comp, caseId, padded, { title: "padded png with eicar" });
    const byTitle = Object.fromEntries((await items(caseId)).map((r) => [r.title, r.scanStatus]));
    observe("06-evidence-storage", "eicar-archive-vs-padded", byTitle);
    expect(byTitle["zip with eicar"]).toBe("REJECTED");
    // environment property, not an application defect: the EICAR signature only matches the exact 68-byte file
    expect(["CLEAN", "REJECTED"]).toContain(byTitle["padded png with eicar"]);
  });
});

describe("superseding evidence", () => {
  it("a party supersedes only its own items, within the same case and only while intake is open; the old object is kept", async () => {
    const caseId = await intakeCase();
    ok(await upload(cast.comp, caseId, png(), { title: "original" }), "original");
    ok(await upload(cast.resp, caseId, text(), { title: "respondent's" }), "respondent item");
    const [mine, theirs] = await items(caseId);
    const supersede = (who: typeof cast.comp, caseIdArg: string, evidenceId: string) => who.client.request("POST", `/api/cases/${caseIdArg}/evidence/${evidenceId}/supersede`, { form: evidenceForm(png(), { title: "replacement" }) });
    expect((await supersede(cast.comp, caseId, theirs.id)).status).toBe(404); // someone else's item
    const otherCase = await intakeCase();
    expect((await supersede(cast.comp, otherCase, mine.id)).status).toBe(404); // item from another case
    expect((await supersede(cast.comp, caseId, "00000000-0000-4000-8000-000000000000")).status).toBe(404);
    ok(await supersede(cast.comp, caseId, mine.id), "own supersede");
    expect(await one(`select version from "EvidenceItem" where "caseId"=$1 and "supersedesId"=$2`, [caseId, mine.id])).toEqual({ version: 2 });
    expect((await getObject(mine.storageKey))!.equals(png())).toBe(true); // original is preserved
    ok(await cast.cm.client.post(`/api/cases/${caseId}/close-intake`, { overrideReason: "audit" }), "close intake");
    expect((await supersede(cast.comp, caseId, mine.id)).status).toBe(409); // intake closed
  });
});

describe("failure handling and cleanup (existing objects are never deleted)", () => {
  async function withTrigger<T>(table: string, condition: string, body: () => Promise<T>) {
    await assertAuditDatabase();
    const name = `audit_fail_${table.toLowerCase()}`;
    await q(`CREATE OR REPLACE FUNCTION ${name}() RETURNS trigger AS $$ BEGIN IF ${condition} THEN RAISE EXCEPTION 'audit injected failure'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
    await q(`CREATE TRIGGER ${name} BEFORE INSERT ON "${table}" FOR EACH ROW EXECUTE FUNCTION ${name}()`);
    try { return await body(); } finally { await q(`DROP TRIGGER IF EXISTS ${name} ON "${table}"`); await q(`DROP FUNCTION IF EXISTS ${name}()`); }
  }
  it("a database failure after the object was written removes the new object and nothing else", async () => {
    const caseId = await intakeCase();
    ok(await upload(cast.comp, caseId, png(), { title: "existing evidence" }), "existing");
    const canary = `live/${caseId}/canary-${Date.now()}`;
    await putObject(canary, Buffer.from("canary must survive"));
    const before = await objectDigests(caseId);
    const eventsBefore = (await caseEvents(caseId)).length;
    const res = await withTrigger("EvidenceItem", `NEW.title LIKE 'FAIL-ME%'`, () => upload(cast.comp, caseId, text("will fail"), { title: "FAIL-ME evidence" }));
    observe("06-evidence-storage", "db-failure-after-upload", { status: res.status, body: res.text.slice(0, 160) });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.text, "internal error detail must not reach the client").not.toMatch(/injected|prisma|Invalid `|constraint|postgres/i);
    expect(await objectDigests(caseId)).toEqual(before);
    expect((await getObject(canary))?.toString()).toBe("canary must survive");
    expect((await items(caseId)).map((i) => i.title)).toEqual(["existing evidence"]);
    expect((await caseEvents(caseId)).length).toBe(eventsBefore);
    await deleteObject(canary);
  });
  it("an event-append failure rolls the whole submission back and removes the new object", async () => {
    const caseId = await intakeCase();
    const before = await objectDigests(caseId);
    const res = await withTrigger("Event", `NEW.type = 'EVIDENCE_SUBMITTED' AND NEW."caseId" = '${caseId}'`, () => upload(cast.comp, caseId, png(), { title: "event failure" }));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await objectDigests(caseId)).toEqual(before);
    expect(await items(caseId)).toEqual([]);
  });
  it("intake closing between the pre-check and the write: the submission is refused (409) and its object is cleaned up", async () => {
    const caseId = await intakeCase();
    ok(await upload(cast.comp, caseId, png(), { title: "kept evidence" }), "kept");
    ok(await upload(cast.resp, caseId, text(), { title: "kept evidence 2" }), "kept 2");
    const before = await objectDigests(caseId);
    const lock = await holdCaseLock(caseId);
    let closing: Promise<{ status: number }>, uploading: Promise<{ status: number; text: string }>;
    try {
      closing = cast.cm.client.post(`/api/cases/${caseId}/close-intake`, {});
      await sleep(600); // the close request has passed its checks and is queued on the row lock
      uploading = upload(cast.comp, caseId, text("late"), { title: "too late" });
      await waitFor(async () => (await keysForCase(caseId)).length > before.size, 20_000); // the late object has been written
    } finally { await lock.release(); }
    const [closed, late] = [await closing!, await uploading!];
    observe("06-evidence-storage", "intake-closes-mid-upload", { closeStatus: closed.status, uploadStatus: late.status, body: late.text.slice(0, 120) });
    expect(closed.status).toBe(200);
    expect(late.status).toBe(409);
    expect(await objectDigests(caseId), "the late object is deleted, the earlier ones untouched").toEqual(before);
    expect((await items(caseId)).map((i) => i.title).sort()).toEqual(["kept evidence", "kept evidence 2"]);
    expect(await types(caseId)).not.toContain("EVIDENCE_SUBMITTED_LATE");
  });
  it("export-record failure: the generated archive is removed, the case is not closed, no row or event is left, and the error does not leak internals", async () => {
    const { caseId } = await driveCase(cast, "RESOLVED_CONSENT");
    const before = await objectDigests(caseId);
    const res = await withTrigger("ExportBundle", `NEW."caseId" = '${caseId}'`, () => cast.cm.client.post(`/api/cases/${caseId}/close`));
    observe("06-evidence-storage", "export-record-failure", { status: res.status, body: res.text.slice(0, 300) });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await objectDigests(caseId), "no orphan archive").toEqual(before);
    expect(Number((await one<{ n: string }>(`select count(*) n from "ExportBundle" where "caseId"=$1`, [caseId]))!.n)).toBe(0);
    expect((await caseRow(caseId))!.state).toBe("RESOLVED_CONSENT");
    expect(await types(caseId)).not.toContain("CASE_CLOSED");
    // and the case can still be closed afterwards (checked before the error-text assertion so a leaking message cannot hide the recovery check)
    ok(await cast.cm.client.post(`/api/cases/${caseId}/close`), "close after recovery");
    expect(res.text, "the 502 body must not echo database/ORM error text").not.toMatch(/Invalid `prisma|injected|exportBundle\.create|constraint|postgres|violates/i);
  });
  it("virus scanner unavailable: uploads are refused (fail closed), nothing is stored, and uploads work again once it returns", async () => {
    const caseId = await intakeCase();
    const before = await objectDigests(caseId);
    await infra("clamd-stop");
    try {
      const res = await upload(cast.comp, caseId, png(), { title: "scanner down" });
      observe("06-evidence-storage", "clamd-down", { status: res.status, body: res.text.slice(0, 120) });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.text).not.toMatch(/ECONNREFUSED|127\.0\.0\.1|3310|clamd/i);
      expect(await objectDigests(caseId)).toEqual(before);
      expect(await items(caseId)).toEqual([]);
    } finally { await infra("clamd-start"); }
    ok(await upload(cast.comp, caseId, png(), { title: "scanner back" }), "after restart");
    expect((await items(caseId))[0].scanStatus).toBe("CLEAN");
  });
  if (cfg.storage === "s3") {
    it("object store unavailable (MinIO stopped): uploads and exports fail with no partial state, the store recovers, and client errors do not reveal the store", async () => {
      const caseId = await intakeCase();
      ok(await upload(cast.comp, caseId, png(), { title: "stored before outage" }), "pre-outage");
      const before = await objectDigests(caseId);
      const resolved = await driveCase(cast, "RESOLVED_CONSENT");
      let up: { status: number; text: string }, close: { status: number; text: string };
      await infra("minio-stop");
      try {
        up = await upload(cast.resp, caseId, text(), { title: "during outage" });
        close = await cast.cm.client.post(`/api/cases/${resolved.caseId}/close`);
        observe("06-evidence-storage", "minio-down", { uploadStatus: up.status, uploadBody: up.text.slice(0, 160), closeStatus: close.status, closeBody: close.text.slice(0, 200) });
      } finally { await infra("minio-start"); }
      expect(up.status).toBeGreaterThanOrEqual(400);
      expect(close.status).toBeGreaterThanOrEqual(400);
      expect(await objectDigests(caseId)).toEqual(before);
      expect((await items(caseId)).map((i) => i.title)).toEqual(["stored before outage"]);
      expect((await caseRow(resolved.caseId))!.state).toBe("RESOLVED_CONSENT");
      expect(await types(resolved.caseId)).not.toContain("CASE_CLOSED");
      ok(await cast.cm.client.post(`/api/cases/${resolved.caseId}/close`), "close after recovery");
      expect(`${up.text} ${close.text}`, "no endpoint, credential or SDK text in client errors").not.toMatch(/127\.0\.0\.1|9010|ECONNREFUSED|AccessKey|aws|s3/i);
    });
  } else {
    it("local disk unavailable for a case directory: uploads fail cleanly with no partial state", async () => {
      const caseId = await intakeCase();
      mkdirSync(join(cfg.localDir, "live"), { recursive: true });
      writeFileSync(join(cfg.localDir, "live", caseId), "not a directory"); // the case's directory cannot be created
      const res = await upload(cast.comp, caseId, png(), { title: "disk fault" });
      observe("06-evidence-storage", "local-disk-fault", { status: res.status, body: res.text.slice(0, 160) });
      rmSync(join(cfg.localDir, "live", caseId), { force: true });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.text).not.toMatch(/ENOTDIR|EEXIST|\/tmp|storage-local/i);
      expect(await items(caseId)).toEqual([]);
    });
  }
});

describe("export bundle: contents, integrity and what each reader may learn", () => {
  const DRAFT_MARKER = "record supports a review of dated materials";
  let caseId = "", reference = "", exportJson: any, zipEntries: Map<string, Buffer>, zipHeaderSha = "", zipSha = "";
  let partyZip: Map<string, Buffer>;
  beforeAll(async () => {
    const { comp, resp, cm, admin } = cast;
    await stub.reset();
    const created = await createCase(comp, resp); ok(created.res, "create"); caseId = created.caseId;
    ok(await comp.client.post(`/api/cases/${caseId}/submit`), "submit");
    ok(await cm.client.post(`/api/cases/${caseId}/open-intake`, { hasConflict: false }), "open");
    ok(await upload(comp, caseId, png(), { title: "COMP-EXHIBIT-MARKER" }), "comp ev");
    ok(await upload(resp, caseId, text(), { title: "RESP-CLEAN-MARKER" }), "resp ev");
    await upload(resp, caseId, eicar(), { title: "RESP-REJECTED-MARKER" });
    ok(await comp.client.post(`/api/cases/${caseId}/chronology`, { occurredOn: "2026-01-02", title: "Événement 📦 文書", description: "Émoji 😀, CJK 文書, RTL مرحبا, combining é — long ".repeat(20), locale: "fr-CA" }), "chronology", 201);
    ok(await cm.client.post(`/api/cases/${caseId}/close-intake`, {}), "close intake");
    ok(await comp.client.post(`/api/cases/${caseId}/positions`, { body: "COMP-POSITION-MARKER ".repeat(40), locale: "en-CA" }), "pos c");
    ok(await resp.client.post(`/api/cases/${caseId}/positions`, { body: "RESP-POSITION-MARKER", locale: "en-CA" }), "pos r");
    ok(await cm.client.post(`/api/cases/${caseId}/draft-requests`), "draft");
    const draft = await cm.client.get(`/api/cases/${caseId}/draft`);
    const edited = { ...draft.json.explanation, summary: "REVIEWED-SUMMARY-MARKER" };
    for (const k of ["model", "reviewer", "knowledge_sources"]) delete edited[k];
    ok(await cm.client.patch(`/api/cases/${caseId}/draft`, { recommendationId: draft.json.id, explanation: edited, reason: "PRIVATE-REVIEW-NOTE-MARKER" }), "review");
    const current = (await caseRow(caseId))!.currentRecommendationId as string;
    ok(await cm.client.post(`/api/recommendations/${current}/issue`, { checklist: { reviewedEvidence: true, confirmedLimits: true, acceptsResponsibility: true } }), "issue");
    const sid = await statementId();
    for (const who of [comp, resp]) ok(await who.client.post(`/api/cases/${caseId}/consent`, { action: "give", statementVersionId: sid }), "consent");
    ok(await admin.client.get(`/api/cases/${caseId}`), "admin read");
    const closed = await cm.client.post(`/api/cases/${caseId}/close`); ok(closed, "close");
    reference = (await caseRow(caseId))!.referenceNumber as string;
    const dl = await comp.client.bytes(`/api/cases/${caseId}/export`);
    expect(dl.status).toBe(200);
    zipHeaderSha = dl.headers.get("x-export-sha256") ?? ""; zipSha = sha(dl.body);
    partyZip = readZip(dl.body); zipEntries = partyZip;
    exportJson = JSON.parse(zipEntries.get("case-record.json")!.toString("utf8"));
  });
  it("is a ZIP of exactly case-record.json, case-record.pdf and verification.txt whose hash matches the recorded and advertised SHA-256", async () => {
    expect([...zipEntries.keys()].sort()).toEqual(["case-record.json", "case-record.pdf", "verification.txt"]);
    const recorded = (await one<{ sha256: string }>(`select sha256 from "ExportBundle" where "caseId"=$1 order by "generatedAt" desc limit 1`, [caseId]))!.sha256;
    expect(zipSha).toBe(recorded); expect(zipHeaderSha).toBe(recorded);
    expect(zipEntries.get("case-record.pdf")!.subarray(0, 5).toString()).toBe("%PDF-");
  });
  it("the PDF renders the record, including non-Latin text, without failing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-pdf-")); writeFileSync(join(dir, "r.pdf"), zipEntries.get("case-record.pdf")!);
    const out = execFileSync("pdftotext", ["-layout", join(dir, "r.pdf"), "-"], { encoding: "utf8" }); rmSync(dir, { recursive: true, force: true });
    expect(out).toContain(reference);
    expect(out).toContain("POSITION-MARKER");
    observe("06-evidence-storage", "pdf-unicode", { containsEmoji: out.includes("😀"), containsCjk: out.includes("文書"), containsArabic: out.includes("مرحبا"), length: out.length });
  });
  it("the sealed timeline re-verifies with the formula published in verification.txt, using only the export", async () => {
    const issues = verifyChain(exportJson.timeline);
    expect(issues).toEqual([]);
    const verification = zipEntries.get("verification.txt")!.toString("utf8");
    expect(verification).toContain("SHA256(prevHash || canonicalJson(payload) || actorId || seq || createdAt_iso)");
    const live = await caseEvents(caseId);
    expect(live.length).toBeGreaterThan(exportJson.timeline.length); // EXPORT_GENERATED and CASE_CLOSED are written after the archive is sealed
    expect(live[exportJson.timeline.length - 1].hash).toBe(exportJson.timeline.at(-1).hash);
    observe("06-evidence-storage", "export-snapshot-state", { exportedCaseState: exportJson.case.state, closedAt: exportJson.case.closedAt, timelineEvents: exportJson.timeline.length, liveEvents: live.length });
  });
  it("exposes no storage keys, buckets or local paths", async () => {
    const all = [...zipEntries.values()].map((b) => b.toString("latin1")).join("\n");
    expect(all).not.toMatch(/storageKey|aequitas-audit-evidence|live\/[0-9a-f-]{36}|storage-local|\/var\/lib/);
  });
  // Confidentiality: a party's export must not reveal what the live workspace withholds from them.
  it("CONFIDENTIALITY: a party's export does not contain the counterparty's e-mail address", async () => {
    const text = zipEntries.get("case-record.json")!.toString("utf8");
    const leaks = [cast.resp.email, cast.cm.email].filter((e) => text.includes(e));
    observe("06-evidence-storage", "export-emails", { partyExportContainsOthersEmail: leaks.length > 0 });
    expect(leaks, "the workspace never shows e-mail addresses; the export gives the complainant the respondent's and the reviewer's").toEqual([]);
  });
  it("CONFIDENTIALITY: a party's export does not contain private reviewer notes", async () => {
    expect(zipEntries.get("case-record.json")!.toString("utf8")).not.toContain("PRIVATE-REVIEW-NOTE-MARKER");
  });
  it("CONFIDENTIALITY: a party's export does not contain unissued or superseded AI drafts", async () => {
    const recs = exportJson.recommendations as Array<{ status: string; explanation: { summary: string } }>;
    observe("06-evidence-storage", "export-recommendations", { statuses: recs.map((r) => r.status) });
    expect(recs.filter((r) => r.status !== "ISSUED").map((r) => r.status), "only issued recommendations belong in a party's copy").toEqual([]);
    expect(zipEntries.get("case-record.json")!.toString("utf8")).not.toContain(DRAFT_MARKER);
  });
  it("CONFIDENTIALITY: a party's export does not list the counterparty's rejected (infected) uploads", async () => {
    const titles = (exportJson.evidence as Array<{ title: string; scanStatus: string }>).map((e) => e.title);
    expect(titles).not.toContain("RESP-REJECTED-MARKER"); // the workspace hides REJECTED items from the other party
  });
  it("CONFIDENTIALITY: a party's export timeline withholds the event types the live API withholds (NOTE_ADDED, RECOMMENDATION_DRAFTED)", async () => {
    const types = (exportJson.timeline as Array<{ type: string }>).map((e) => e.type);
    observe("06-evidence-storage", "export-staff-events", { includesAccessStaffGranted: types.includes("ACCESS_STAFF_GRANTED"), includesNoteAdded: types.includes("NOTE_ADDED"), includesDrafted: types.includes("RECOMMENDATION_DRAFTED") });
    const live = await cast.comp.client.get(`/api/cases/${caseId}/events`);
    const liveTypes = new Set((live.json as Array<{ type: string }>).map((e) => e.type));
    const leaked = [...new Set(types)].filter((t) => !liveTypes.has(t));
    expect(leaked, "event types in the party's export that the party's live timeline never shows").toEqual([]);
  });
  it("the other party and the reviewer receive the identical archive; outsiders and other managers receive nothing", async () => {
    const respDl = await cast.resp.client.bytes(`/api/cases/${caseId}/export`);
    expect(sha(respDl.body)).toBe(zipSha);
    expect((await cast.cm.client.bytes(`/api/cases/${caseId}/export`)).status).toBe(200);
    const outsider = await (await import("./lib/world")).makeAccount("COMPLAINANT", "export-outsider");
    expect((await outsider.client.bytes(`/api/cases/${caseId}/export`)).status).toBe(404);
  });
  it("a large but ordinary record (300 KB of prose, 20 long chronology entries) exports and closes in reasonable time", async () => {
    const { comp, resp, cm } = cast;
    const created = await createCase(comp, resp); ok(created.res, "create");
    const id = created.caseId;
    ok(await comp.client.post(`/api/cases/${id}/submit`), "submit"); ok(await cm.client.post(`/api/cases/${id}/open-intake`, { hasConflict: false }), "open");
    const prose = (n: number) => "Le plaignant déclare que la marchandise n'est jamais arrivée à destination. ".repeat(Math.ceil(n / 72)).slice(0, n);
    for (let i = 0; i < 20; i++) ok(await comp.client.post(`/api/cases/${id}/chronology`, { occurredOn: "2026-01-02", title: `Entrée ${i}`, description: prose(8000), locale: "fr-CA" }), "chron", 201);
    ok(await upload(comp, id, png(), { title: "e" }), "ev"); ok(await upload(resp, id, text(), { title: "e2" }), "ev2");
    ok(await cm.client.post(`/api/cases/${id}/close-intake`, {}), "close intake");
    ok(await comp.client.post(`/api/cases/${id}/positions`, { body: prose(300_000) }), "big position"); ok(await resp.client.post(`/api/cases/${id}/positions`, { body: "r" }), "pos");
    ok(await comp.client.post(`/api/cases/${id}/withdraw`), "withdraw");
    const started = Date.now();
    const closed = await cm.client.post(`/api/cases/${id}/close`);
    const ms = Date.now() - started;
    observe("06-evidence-storage", "large-prose-export", { status: closed.status, ms });
    expect(closed.status, closed.text.slice(0, 200)).toBe(200);
    expect(ms).toBeLessThan(30_000);
  });
  it("AVAILABILITY: generating an export for a record with long unbroken text does not freeze the whole server", async () => {
    const { comp, resp, cm } = cast;
    const created = await createCase(comp, resp); ok(created.res, "create");
    const id = created.caseId;
    ok(await comp.client.post(`/api/cases/${id}/submit`), "submit"); ok(await cm.client.post(`/api/cases/${id}/open-intake`, { hasConflict: false }), "open");
    ok(await upload(comp, id, png(), { title: "e" }), "ev"); ok(await upload(resp, id, text(), { title: "e2" }), "ev2");
    ok(await cm.client.post(`/api/cases/${id}/close-intake`, {}), "close intake");
    ok(await comp.client.post(`/api/cases/${id}/positions`, { body: "p".repeat(100_000) }), "unbroken position"); ok(await resp.client.post(`/api/cases/${id}/positions`, { body: "r" }), "pos");
    ok(await comp.client.post(`/api/cases/${id}/withdraw`), "withdraw");
    let worst = 0, probes = 0, stop = false;
    const prober = (async () => { while (!stop) { const t = Date.now(); try { await fetch(`${cfg.base}/api/health`, { headers: { connection: "close" }, signal: AbortSignal.timeout(120_000) }); } catch { /* counted as worst */ } worst = Math.max(worst, Date.now() - t); probes++; await sleep(250); } })();
    const started = Date.now();
    const closed = await cm.client.post(`/api/cases/${id}/close`);
    const exportMs = Date.now() - started;
    stop = true; await prober;
    observe("06-evidence-storage", "export-event-loop-blocking", { inputChars: 100_000, exportMs, status: closed.status, healthProbes: probes, worstHealthLatencyMs: worst });
    expect(closed.status).toBe(200);
    expect(worst, `worst /api/health latency while an export ran for ${exportMs} ms`).toBeLessThan(3_000);
  });
});

describe("storage module key validation (in-process, real filesystem)", () => {
  it("rejects unsafe keys before touching the disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-store-"));
    process.env.STORAGE_LOCAL_DIR = dir;
    const storage = await import("../../src/lib/storage");
    const outside = join(dir, "..", `audit-outside-${Date.now()}`);
    const bad = ["../x", "a/../../x", "/abs", "a\\b", "./x", "a/./b", "", "a/../b"];
    for (const key of bad) {
      await expect(storage.uploadBuffer({ storageKey: key, buffer: Buffer.from("x"), mimeType: "text/plain" }), JSON.stringify(key)).rejects.toThrow();
      await expect(storage.downloadBuffer(key), JSON.stringify(key)).rejects.toThrow();
    }
    expect(existsSync(outside)).toBe(false);
    await storage.uploadBuffer({ storageKey: "live/c/e", buffer: Buffer.from("ok"), mimeType: "text/plain" });
    expect((await storage.downloadBuffer("live/c/e")).toString()).toBe("ok");
    await expect(storage.downloadBuffer("live/c/missing")).rejects.toThrow();
    await storage.deleteBuffer("live/c/e");
    delete process.env.STORAGE_LOCAL_DIR;
    rmSync(dir, { recursive: true, force: true });
  });
});
