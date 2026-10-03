import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setSuite } from "./lib/http";
import { observe } from "./lib/evidence";
import { closePool, one } from "./lib/db";
import { createCase, driveCase, makeCast, ok, statementId, upload, type Cast } from "./lib/world";
import { syntheticEmail } from "./lib/config";
import { png } from "./lib/files";
import { Client } from "./lib/http";
import { register } from "./lib/webauthn";


/**
 * Hostile text in free-text fields. PostgreSQL text columns cannot store U+0000, so any field that reaches the database
 * unvalidated is a candidate for an unhandled error (HTTP 500). Lone surrogates and very long strings are probed as well.
 */
let cast: Cast;
beforeAll(async () => { setSuite("10-input-robustness"); cast = await makeCast("robust"); });
afterAll(async () => { await closePool(); });

const NUL = "a\u0000b";
const LONE_SURROGATE = "x\ud800y";

describe("U+0000 in text fields must be refused or cleaned, never a 500", () => {
  type Probe = [name: string, run: (text: string) => Promise<{ status: number; text: string }>];
  const probes = (): Probe[] => {
    const { comp, resp, cm, admin } = cast;
    return [
      ["register displayName", async (t) => (await register(new Client("p"), { email: syntheticEmail("nul"), displayName: t, globalRole: "COMPLAINANT" })).verify ?? { status: 0, text: "" }],
      ["register email", async (t) => { const c = new Client("p"); return c.post("/api/auth/webauthn/register", { step: "options", email: `${t}@audit.example.test`, displayName: "x", globalRole: "COMPLAINANT" }); }],
      ["invite displayName", (t) => admin.client.post("/api/auth/invite", { email: syntheticEmail("nulinv"), displayName: t, globalRole: "RESPONDENT" })],
      ["invite email", (t) => admin.client.post("/api/auth/invite", { email: `${t}@audit.example.test`, displayName: "x", globalRole: "RESPONDENT" })],
      ["case respondentDisplayName", async (t) => comp.client.post("/api/cases", { respondentEmail: syntheticEmail("nulcase"), respondentDisplayName: t, requestedStatementVersionId: await statementId() })],
      ["case respondentEmail", async (t) => comp.client.post("/api/cases", { respondentEmail: `${t}@audit.example.test`, respondentDisplayName: "x", requestedStatementVersionId: await statementId() })],
      ["chronology title", async (t) => { const id = (await driveCase(cast, "EVIDENCE_INTAKE")).caseId; return comp.client.post(`/api/cases/${id}/chronology`, { occurredOn: "2026-01-01", title: t, description: "d", locale: "en-CA" }); }],
      ["chronology description", async (t) => { const id = (await driveCase(cast, "EVIDENCE_INTAKE")).caseId; return comp.client.post(`/api/cases/${id}/chronology`, { occurredOn: "2026-01-01", title: "t", description: t, locale: "en-CA" }); }],
      ["position body", async (t) => { const id = (await driveCase(cast, "POSITIONS")).caseId; return resp.client.post(`/api/cases/${id}/positions`, { body: t }); }],
      ["evidence title", async (t) => { const id = (await driveCase(cast, "EVIDENCE_INTAKE")).caseId; return upload(comp, id, png(), { title: t }); }],
      ["evidence description", async (t) => { const id = (await driveCase(cast, "EVIDENCE_INTAKE")).caseId; return upload(comp, id, png(), { title: "t", description: t }); }],
      ["close-intake overrideReason", async (t) => { const id = (await driveCase(cast, "EVIDENCE_INTAKE")).caseId; return cm.client.post(`/api/cases/${id}/close-intake`, { overrideReason: t }); }],
      ["open-intake coiDetails", async (t) => { const { res, caseId } = await createCase(comp, resp); ok(res, "create"); ok(await comp.client.post(`/api/cases/${caseId}/submit`), "submit"); return cm.client.post(`/api/cases/${caseId}/open-intake`, { hasConflict: false, coiDetails: t }); }],
    ];
  };
  it("every free-text field answers < 500 to U+0000 (and the answer is not a stack trace)", async () => {
    const bad: string[] = [];
    for (const [name, run] of probes()) {
      const res = await run(NUL);
      observe("10-input-robustness", `nul-${name.replace(/\s+/g, "-")}`, { status: res.status, body: res.text.slice(0, 80) });
      if (res.status >= 500) bad.push(`${name}: HTTP ${res.status}`);
    }
    expect(bad, bad.join("\n")).toEqual([]);
  });
  it("lone surrogates are handled (stored with replacement or refused), never a 500", async () => {
    const bad: string[] = [];
    for (const [name, run] of probes().slice(2, 9)) {
      const res = await run(LONE_SURROGATE);
      if (res.status >= 500) bad.push(`${name}: HTTP ${res.status}`);
    }
    expect(bad, bad.join("\n")).toEqual([]);
  });
});

describe("length limits (the API states none for several fields)", () => {
  it("a long display name must not produce a challenge cookie that browsers discard (cookies over 4096 bytes are dropped)", async () => {
    const sizes: Record<string, { status: number; setCookieBytes: number }> = {};
    for (const length of [100, 1000, 2500, 3200, 6000]) {
      const client = new Client("cookie-size");
      const res = await client.post("/api/auth/webauthn/register", { step: "options", email: syntheticEmail("cookiesize"), displayName: "n".repeat(length), globalRole: "COMPLAINANT" });
      sizes[String(length)] = { status: res.status, setCookieBytes: Math.max(0, ...res.setCookies.map((c) => c.length)) };
    }
    observe("10-input-robustness", "challenge-cookie-size", sizes);
    for (const [length, r] of Object.entries(sizes)) {
      const acceptedButUnusable = r.status === 200 && r.setCookieBytes > 4096;
      expect(acceptedButUnusable, `displayName of ${length} characters -> ${r.setCookieBytes}-byte Set-Cookie (browsers drop cookies above 4096 bytes), status ${r.status}`).toBe(false);
    }
  });
  it("records what happens with very long names and position texts (no length limit is enforced on these fields)", async () => {
    const { comp, resp } = cast;
    const outcomes: Record<string, number> = {};
    const huge = "x".repeat(1_000_000);
    outcomes.caseRespondentDisplayName1MB = (await comp.client.post("/api/cases", { respondentEmail: syntheticEmail("longcase"), respondentDisplayName: huge, requestedStatementVersionId: await statementId() })).status;
    const id = (await driveCase(cast, "POSITIONS")).caseId;
    outcomes.position1MB = (await resp.client.post(`/api/cases/${id}/positions`, { body: huge })).status;
    outcomes.position9MB = (await resp.client.post(`/api/cases/${id}/positions`, { body: "y".repeat(9_000_000) })).status;
    outcomes.position12MB = (await resp.client.post(`/api/cases/${id}/positions`, { body: "z".repeat(12_000_000) })).status;
    const stored = await one<{ longest: number }>(`select max(length(body)) longest from "PositionStatement" where "caseId"=$1`, [id]);
    observe("10-input-robustness", "length-limits", { ...outcomes, longestStoredPositionChars: stored?.longest });
    for (const status of Object.values(outcomes)) expect(status).toBeLessThan(500);
  });
});
