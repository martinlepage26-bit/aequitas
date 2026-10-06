import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EventType } from "../../src/generated/prisma";
import { prisma } from "../../src/lib/prisma";
import { signPayload } from "../../src/lib/signedCookie";
import { SESSION_COOKIE } from "../../src/lib/session";
import { createCase, openIntake, submitCase } from "../../src/domain/mutate";
import { filterEventsForRole } from "../../src/domain/eventTimeline";
import { startNextDev, type DevServer } from "../helpers/nextDevServer";

/**
 * H2: only the ASSIGNED case manager gets the full case read (workspace
 * page, projection, full timeline incl. private notes). Any other manager
 * sees a case only while it is OPEN and unclaimed (the claim screen), and
 * then only the party-level timeline.
 */

describe("filterEventsForRole takes assignment into account", () => {
  const events = (["CASE_CREATED", "NOTE_ADDED", "RECOMMENDATION_DRAFTED"] as EventType[]).map((type, i) => ({ type, seq: i + 1 }));

  it("the assigned case manager sees private notes and drafts", () => {
    expect(filterEventsForRole(events, "CASE_MANAGER", true).map((e) => e.type)).toEqual(["CASE_CREATED", "NOTE_ADDED", "RECOMMENDATION_DRAFTED"]);
  });

  it("an unassigned case manager does not", () => {
    expect(filterEventsForRole(events, "CASE_MANAGER", false).map((e) => e.type)).toEqual(["CASE_CREATED"]);
  });
});

const PORT = 3424;
let server: DevServer;
let base: string;
let complainantId: string;
let respondentId: string;
let managerId: string;
let otherManagerId: string;
let assignedCaseId: string;
let openCaseId: string;

function cookie(userId: string, globalRole: string) {
  return { Cookie: `${SESSION_COOKIE}=${signPayload({ purpose: "session", userId, globalRole, authMethod: "passkey"  }, 3600)}` };
}

beforeAll(async () => {
  server = await startNextDev(PORT);
  base = server.baseUrl;
  const [c, r, m, m2, sv] = await Promise.all([
    prisma.user.create({ data: { email: `h2-c-${randomUUID()}@example.com`, displayName: "H2 Complainant", globalRole: "COMPLAINANT" } }),
    prisma.user.create({ data: { email: `h2-r-${randomUUID()}@example.com`, displayName: "H2 Respondent", globalRole: "RESPONDENT" } }),
    prisma.user.create({ data: { email: `h2-m-${randomUUID()}@example.com`, displayName: "H2 Manager", globalRole: "CASE_MANAGER" } }),
    prisma.user.create({ data: { email: `h2-m2-${randomUUID()}@example.com`, displayName: "H2 Other Manager", globalRole: "CASE_MANAGER" } }),
    prisma.consentStatementVersion.create({
      data: { version: Number.parseInt(randomUUID().replaceAll("-", "").slice(0, 8), 16) % 2_000_000_000, locale: "fr-CA", body: "Test.", effectiveFrom: new Date() },
    }),
  ]);
  complainantId = c.id;
  respondentId = r.id;
  managerId = m.id;
  otherManagerId = m2.id;

  async function submitted() {
    const created = await createCase({
      actorId: complainantId,
      actorRole: "COMPLAINANT",
      referenceNumber: `AE-H2-${randomUUID().slice(0, 8)}`,
      complainantId,
      respondentId,
      simulated: true,
      disputeDescription: "The other party did not do what we agreed.",
      requestedStatementVersionId: sv.id,
      currentStatementVersionId: sv.id,
    });
    if (!created.ok) throw new Error("setup: createCase failed");
    const sub = await submitCase({ actorId: complainantId, actorRole: "COMPLAINANT", caseId: created.data.caseId });
    if (!sub.ok) throw new Error("setup: submitCase failed");
    return created.data.caseId;
  }
  assignedCaseId = await submitted();
  const opened = await openIntake({ actorId: managerId, actorRole: "CASE_MANAGER", caseId: assignedCaseId, hasConflict: false });
  if (!opened.ok) throw new Error("setup: openIntake failed");
  openCaseId = await submitted();
}, 240_000);

afterAll(async () => {
  await server?.stop();
  await prisma.$disconnect();
});

describe("H2 over HTTP: a claimed case is readable only by its parties and its assigned manager", () => {
  it.each([
    ["events", (id: string) => `/api/cases/${id}/events`],
    ["projection", (id: string) => `/api/cases/${id}`],
    ["workspace page", (id: string) => `/fr-CA/cases/${id}`],
  ])("a different case manager gets 404 on the %s of a claimed case", async (_label, path) => {
    const res = await fetch(`${base}${path(assignedCaseId)}`, { headers: cookie(otherManagerId, "CASE_MANAGER") });
    expect(res.status).toBe(404);
  }, 20_000);

  it.each([
    ["events", (id: string) => `/api/cases/${id}/events`],
    ["projection", (id: string) => `/api/cases/${id}`],
    ["workspace page", (id: string) => `/fr-CA/cases/${id}`],
  ])("the assigned case manager still gets 200 on the %s", async (_label, path) => {
    const res = await fetch(`${base}${path(assignedCaseId)}`, { headers: cookie(managerId, "CASE_MANAGER") });
    expect(res.status).toBe(200);
  });

  it("a party still reads their own claimed case", async () => {
    const res = await fetch(`${base}/api/cases/${assignedCaseId}/events`, { headers: cookie(respondentId, "RESPONDENT") });
    expect(res.status).toBe(200);
  });

  it("any case manager can still open an OPEN, unclaimed case (the claim screen)", async () => {
    const page = await fetch(`${base}/fr-CA/cases/${openCaseId}`, { headers: cookie(otherManagerId, "CASE_MANAGER") });
    expect(page.status).toBe(200);
    const events = await fetch(`${base}/api/cases/${openCaseId}/events`, { headers: cookie(otherManagerId, "CASE_MANAGER") });
    expect(events.status).toBe(200);
  });
});
