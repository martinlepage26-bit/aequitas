import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../src/lib/prisma";
import { signPayload } from "../../src/lib/signedCookie";
import { SESSION_COOKIE } from "../../src/lib/session";
import { createCase, openIntake, submitCase } from "../../src/domain/mutate";
import { startNextDev, type DevServer } from "../helpers/nextDevServer";

/**
 * Regression for security-audit finding 5.3 (aequitas-audit-run1, Area 5,
 * evidence/area5-storage.jsonl): the evidence route advertises a 25 MB cap
 * (src/app/api/cases/[caseId]/evidence/route.ts:10,33-35), but with
 * src/proxy.ts in place, Next 16's experimental.proxyClientMaxBodySize
 * (default 10 MB — node_modules/next/dist/docs/01-app/03-api-reference/
 * 05-config/01-next-config-js/proxyClientMaxBodySize.md) silently truncates
 * larger multipart bodies before the route runs. request.formData() then
 * throws and the route answers 400 "Expected multipart/form-data." — a
 * misleading message, and the advertised cap is never reached. Confirmed in
 * production mode (`next start`) by bracketing: 9 MiB -> 200, 10 MiB ->
 * 400 "Expected multipart/form-data.", exactly 25 MiB -> same 400.
 *
 * These tests protect the proxy and route size limits:
 *   1. an exactly-25MiB upload is accepted (the route cap is `>` MAX_BYTES,
 *      so exactly-at-limit must pass);
 *   2. an over-25MiB upload is rejected with a size-specific message, not a
 *      generic form-parsing error.
 */
const PORT = 3431;
const MIB = 1024 * 1024;

let server: DevServer;
let base: string;
let complainantId: string;
let respondentId: string;
let managerId: string;
let statementVersionId: string;

const cookieFor = (userId: string, globalRole: string) =>
  `${SESSION_COOKIE}=${signPayload({ purpose: "session", userId, globalRole, authMethod: "dev-bypass" }, 3600)}`;

async function freshEvidenceIntakeCase(): Promise<string> {
  const created = await createCase({
    actorId: complainantId, actorRole: "COMPLAINANT",
    referenceNumber: `AE-REGR-LIM-${randomUUID().slice(0, 8)}`,
    complainantId, respondentId, simulated: true,
    disputeDescription: "The submitted evidence concerns a disputed agreement.",
    requestedStatementVersionId: statementVersionId, currentStatementVersionId: statementVersionId,
  });
  if (!created.ok) throw new Error("setup: createCase failed");
  const submitted = await submitCase({ actorId: complainantId, actorRole: "COMPLAINANT", caseId: created.data.caseId });
  if (!submitted.ok) throw new Error("setup: submitCase failed");
  const opened = await openIntake({ actorId: managerId, actorRole: "CASE_MANAGER", caseId: created.data.caseId, hasConflict: false });
  if (!opened.ok) throw new Error("setup: openIntake failed");
  return created.data.caseId;
}

function uploadText(caseId: string, bytes: number) {
  const form = new FormData();
  form.set("kind", "DOCUMENT");
  form.set("title", `size probe ${bytes}`);
  form.set("file", new Blob([Buffer.alloc(bytes, 0x41)], { type: "text/plain" }), "probe.txt");
  return fetch(`${base}/api/cases/${caseId}/evidence`, {
    method: "POST",
    headers: { Cookie: cookieFor(complainantId, "COMPLAINANT") },
    body: form,
  });
}

beforeAll(async () => {
  server = await startNextDev(PORT);
  base = server.baseUrl;
  const [consumer, retailer, manager, statementVersion] = await Promise.all([
    prisma.user.create({ data: { email: `regr-lim-c-${randomUUID()}@example.com`, displayName: "Regression Consumer", globalRole: "COMPLAINANT" } }),
    prisma.user.create({ data: { email: `regr-lim-r-${randomUUID()}@example.com`, displayName: "Regression Retailer", globalRole: "RESPONDENT" } }),
    prisma.user.create({ data: { email: `regr-lim-m-${randomUUID()}@example.com`, displayName: "Regression Manager", globalRole: "CASE_MANAGER" } }),
    prisma.consentStatementVersion.create({
      data: { version: Number.parseInt(randomUUID().replaceAll("-", "").slice(0, 8), 16) % 2_000_000_000, locale: "fr-CA", body: "Test.", effectiveFrom: new Date() },
    }),
  ]);
  complainantId = consumer.id;
  respondentId = retailer.id;
  managerId = manager.id;
  statementVersionId = statementVersion.id;
}, 240_000);

afterAll(async () => { await server?.stop(); await prisma.$disconnect(); });

describe("Evidence upload size limits (finding 5.3 regression)", () => {
  it("accepts an exactly-25MiB upload (the route cap is strictly greater-than)", async () => {
    const caseId = await freshEvidenceIntakeCase();
    const res = await uploadText(caseId, 25 * MIB);
    expect(res.status).toBe(200);
    const item = await prisma.evidenceItem.findFirst({ where: { caseId } });
    expect(item).not.toBeNull();
    expect(item!.scanStatus).toBe("CLEAN");
    expect(item!.byteSize).toBe(25 * MIB);
  }, 120_000);

  it("rejects an over-25MiB upload with a size-specific message, not a form-parsing error", async () => {
    const caseId = await freshEvidenceIntakeCase();
    const res = await uploadText(caseId, 26 * MIB);
    expect([400, 413]).toContain(res.status);
    const body = await res.json().catch(() => ({}));
    const message = String(body?.message ?? "");
    expect(message).not.toBe("Expected multipart/form-data.");
    expect(message).toMatch(/size|exceed|limit|too large/i);
    expect(await prisma.evidenceItem.count({ where: { caseId } })).toBe(0);
  }, 120_000);
});
