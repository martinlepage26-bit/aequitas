import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../src/lib/prisma";
import { signPayload } from "../../src/lib/signedCookie";
import { SESSION_COOKIE } from "../../src/lib/session";
import { closeIntake, createCase, openIntake, submitCase } from "../../src/domain/mutate";

// A real, minimal valid 1x1 transparent PNG — file-type's magic-number
// sniff (which the evidence route always runs before any RBAC check) needs
// actual valid structure, not just a guessed byte prefix. See DECISIONS.md's
// M2 note on this exact pitfall from earlier live testing.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

/**
 * M2's own "Done when" criterion (Section 19): "RBAC negative tests pass."
 * The domain-level suites (case-lifecycle.test.ts, mutate.test.ts) already
 * exhaustively cover every guard combination by calling mutation functions
 * directly; what those can't prove is that the HTTP layer itself — request
 * parsing, requireSession's cookie check, and mutationFailureResponse's
 * step->status mapping — actually wires those outcomes to the right status
 * code end to end. `requireSession` calls next/headers's `cookies()`, which
 * throws when called outside a real request scope (confirmed directly:
 * importing and invoking a route handler's exported function bypasses
 * Next's request-scoped storage entirely) — so this suite spawns a real
 * `next dev` server and drives it with real `fetch()`, the same discipline
 * this project already applies to MinIO/ClamAV/Postgres rather than mocking
 * them. Scope is deliberately the RBAC status-code contract (401/403/404/409)
 * across a representative sample of routes, not a second exhaustive replay
 * of every guard already covered at the domain level.
 */

const PORT = 3419;
const BASE_URL = `http://localhost:${PORT}`;

let serverProcess: ChildProcess;

async function waitForServer() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/`);
      if (res.status > 0) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Dev server on port ${PORT} did not become ready in time.`);
}

beforeAll(async () => {
  serverProcess = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--port", String(PORT)], {
    cwd: process.cwd(),
    stdio: "ignore",
    detached: true,
  });
  await waitForServer();
}, 90_000);

afterAll(async () => {
  if (serverProcess?.pid) {
    try {
      process.kill(-serverProcess.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  await prisma.$disconnect();
});

function cookieFor(userId: string, globalRole: string): string {
  const token = signPayload({ purpose: "session", userId, globalRole , authMethod: "dev-bypass" }, 60 * 60);
  return `${SESSION_COOKIE}=${token}`;
}

let complainantId: string;
let respondentId: string;
let managerId: string;
let otherManagerId: string;
let outsiderConsumerId: string;
let statementVersionId: string;

beforeAll(async () => {
  const [consumer, retailer, manager, otherManager, outsiderConsumer, statementVersion] = await Promise.all([
    prisma.user.create({ data: { email: `rbac-consumer-${randomUUID()}@example.com`, displayName: "RBAC Consumer", globalRole: "COMPLAINANT" } }),
    prisma.user.create({ data: { email: `rbac-retailer-${randomUUID()}@example.com`, displayName: "RBAC Retailer", globalRole: "RESPONDENT" } }),
    prisma.user.create({ data: { email: `rbac-manager-${randomUUID()}@example.com`, displayName: "RBAC Manager", globalRole: "CASE_MANAGER" } }),
    prisma.user.create({ data: { email: `rbac-manager2-${randomUUID()}@example.com`, displayName: "RBAC Other Manager", globalRole: "CASE_MANAGER" } }),
    prisma.user.create({ data: { email: `rbac-outsider-${randomUUID()}@example.com`, displayName: "RBAC Outsider", globalRole: "COMPLAINANT" } }),
    prisma.consentStatementVersion.create({
      data: { version: Number.parseInt(randomUUID().replaceAll("-", "").slice(0, 8), 16) % 2_000_000_000, locale: "fr-CA", body: "Test.", effectiveFrom: new Date() },
    }),
  ]);
  complainantId = consumer.id;
  respondentId = retailer.id;
  managerId = manager.id;
  otherManagerId = otherManager.id;
  outsiderConsumerId = outsiderConsumer.id;
  statementVersionId = statementVersion.id;
});

async function freshEvidenceIntakeCase(): Promise<string> {
  const created = await createCase({
    actorId: complainantId,
    actorRole: "COMPLAINANT",
    referenceNumber: `AE-RBAC-${randomUUID().slice(0, 8)}`,
    complainantId,
    respondentId,
    simulated: true,
    disputeDescription: "The other party did not do what we agreed.",
    requestedStatementVersionId: statementVersionId,
    currentStatementVersionId: statementVersionId,
  });
  if (!created.ok) throw new Error("setup: createCase failed");
  const submitted = await submitCase({ actorId: complainantId, actorRole: "COMPLAINANT", caseId: created.data.caseId });
  if (!submitted.ok) throw new Error("setup: submitCase failed");
  const opened = await openIntake({ actorId: managerId, actorRole: "CASE_MANAGER", caseId: created.data.caseId, hasConflict: false });
  if (!opened.ok) throw new Error("setup: openIntake failed");
  return created.data.caseId;
}

async function freshPositionsCase(): Promise<string> {
  const caseId = await freshEvidenceIntakeCase();
  const closed = await closeIntake({
    actorId: managerId,
    actorRole: "CASE_MANAGER",
    caseId,
    overrideReason: "Test fixture — skipping evidence coverage to reach POSITIONS.",
  });
  if (!closed.ok) throw new Error("setup: closeIntake failed");
  return caseId;
}

describe("RBAC over real HTTP — unauthenticated requests (401)", () => {
  it.each([
    ["POST", "/api/cases"],
    ["POST", "/api/cases/any-id/submit"],
    ["POST", "/api/cases/any-id/open-intake"],
    ["POST", "/api/cases/any-id/close-intake"],
    ["POST", "/api/cases/any-id/positions"],
    ["GET", "/api/cases/any-id/events"],
  ])("%s %s -> 401 with no session cookie", async (method, path) => {
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: method === "POST" ? "{}" : undefined,
    });
    expect(res.status).toBe(401);
  });
});

describe("RBAC over real HTTP — wrong role (403)", () => {
  it("retailer handler cannot open evidence intake", async () => {
    const caseId = await freshEvidenceIntakeCase();
    const res = await fetch(`${BASE_URL}/api/cases/${caseId}/open-intake`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieFor(respondentId, "RESPONDENT") },
      body: JSON.stringify({ hasConflict: false }),
    });
    expect(res.status).toBe(403);
  });

  it("case manager cannot submit evidence", async () => {
    const caseId = await freshEvidenceIntakeCase();
    const form = new FormData();
    form.set("kind", "DOCUMENT");
    form.set("title", "Should be rejected");
    form.set("file", new Blob([TINY_PNG]), "test.png");
    const res = await fetch(`${BASE_URL}/api/cases/${caseId}/evidence`, {
      method: "POST",
      headers: { Cookie: cookieFor(managerId, "CASE_MANAGER") },
      body: form,
    });
    expect(res.status).toBe(403);
  });

  it("consumer cannot close evidence intake", async () => {
    const caseId = await freshEvidenceIntakeCase();
    const res = await fetch(`${BASE_URL}/api/cases/${caseId}/close-intake`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieFor(complainantId, "COMPLAINANT") },
      body: "{}",
    });
    expect(res.status).toBe(403);
  });

  it("case manager cannot submit a position", async () => {
    const caseId = await freshEvidenceIntakeCase();
    const res = await fetch(`${BASE_URL}/api/cases/${caseId}/positions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieFor(managerId, "CASE_MANAGER") },
      body: JSON.stringify({ body: "Should be rejected" }),
    });
    expect(res.status).toBe(403);
  });
});

describe("RBAC over real HTTP — right role, not this case's party/manager (404, Section 16)", () => {
  it("a different consumer cannot submit this case", async () => {
    const created = await createCase({
      actorId: complainantId,
      actorRole: "COMPLAINANT",
      referenceNumber: `AE-RBAC-${randomUUID().slice(0, 8)}`,
      complainantId,
      respondentId,
      simulated: true,
      disputeDescription: "The other party did not do what we agreed.",
      requestedStatementVersionId: statementVersionId,
      currentStatementVersionId: statementVersionId,
    });
    if (!created.ok) throw new Error("setup failed");

    const res = await fetch(`${BASE_URL}/api/cases/${created.data.caseId}/submit`, {
      method: "POST",
      headers: { Cookie: cookieFor(outsiderConsumerId, "COMPLAINANT") },
    });
    expect(res.status).toBe(404);
  });

  it("an unrelated retailer handler cannot submit evidence on this case", async () => {
    const caseId = await freshEvidenceIntakeCase();
    const outsiderRetailer = await prisma.user.create({
      data: { email: `rbac-outsider-retailer-${randomUUID()}@example.com`, displayName: "Outsider Retailer", globalRole: "RESPONDENT" },
    });
    const form = new FormData();
    form.set("kind", "DOCUMENT");
    form.set("title", "Not my case");
    form.set("file", new Blob([TINY_PNG]), "test.png");
    const res = await fetch(`${BASE_URL}/api/cases/${caseId}/evidence`, {
      method: "POST",
      headers: { Cookie: cookieFor(outsiderRetailer.id, "RESPONDENT") },
      body: form,
    });
    expect(res.status).toBe(404);
  });

  it("a case manager who never claimed this case cannot close intake", async () => {
    const caseId = await freshEvidenceIntakeCase();
    const res = await fetch(`${BASE_URL}/api/cases/${caseId}/close-intake`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieFor(otherManagerId, "CASE_MANAGER") },
      body: "{}",
    });
    expect(res.status).toBe(404);
  });

  it("an unrelated consumer cannot submit a position on this case", async () => {
    const caseId = await freshPositionsCase();
    const res = await fetch(`${BASE_URL}/api/cases/${caseId}/positions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieFor(outsiderConsumerId, "COMPLAINANT") },
      body: JSON.stringify({ body: "Not my case" }),
    });
    expect(res.status).toBe(404);
  });

  it("an unrelated consumer cannot read this case's event timeline", async () => {
    const caseId = await freshEvidenceIntakeCase();
    const res = await fetch(`${BASE_URL}/api/cases/${caseId}/events`, {
      headers: { Cookie: cookieFor(outsiderConsumerId, "COMPLAINANT") },
    });
    expect(res.status).toBe(404);
  });
});

describe("RBAC over real HTTP — real business-rule conflict (409, not 403/404)", () => {
  it("closing intake without any evidence and no override reason is a 409, not a role/access failure", async () => {
    const caseId = await freshEvidenceIntakeCase();
    const res = await fetch(`${BASE_URL}/api/cases/${caseId}/close-intake`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieFor(managerId, "CASE_MANAGER") },
      body: "{}",
    });
    expect(res.status).toBe(409);
  });
});

describe("RBAC over real HTTP — the correct actor still succeeds (sanity check on the same routes)", () => {
  it("the assigned manager can close intake with an override reason", async () => {
    const caseId = await freshEvidenceIntakeCase();
    const res = await fetch(`${BASE_URL}/api/cases/${caseId}/close-intake`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieFor(managerId, "CASE_MANAGER") },
      body: JSON.stringify({ overrideReason: "No response from either party within SLA." }),
    });
    expect(res.status).toBe(200);
  });
});
