import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";
import { GENESIS_HASH, computeEventHash } from "../../src/domain/events";

const PHASE3 = "20261011180000_contestation_approval";
const APPLY_DB = "aequitas_phase3_apply_test";

function adminUrl(): string {
  const url = new URL(process.env.DATABASE_URL ?? "");
  url.pathname = "/aequitas_test";
  return url.toString();
}

function applyUrl(): string {
  const url = new URL(adminUrl());
  url.pathname = `/${APPLY_DB}`;
  return url.toString();
}

async function admin(query: (client: pg.Client) => Promise<void>) {
  const client = new pg.Client({ connectionString: adminUrl() });
  await client.connect();
  try {
    await client.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()", [APPLY_DB]);
    await query(client);
  } finally {
    await client.end();
  }
}

describe("phase 3 migration applies on a database with live cases", () => {
  afterAll(async () => {
    await admin(async (client) => {
      await client.query(`DROP DATABASE IF EXISTS "${APPLY_DB}"`);
    });
  });

  it("marks every existing case consent-only, keeps their rows, and new cases require sign-off", async () => {
    await admin(async (client) => {
      await client.query(`DROP DATABASE IF EXISTS "${APPLY_DB}"`);
      await client.query(`CREATE DATABASE "${APPLY_DB}"`);
    });
    const client = new pg.Client({ connectionString: applyUrl() });
    await client.connect();
    try {
      const migrationsDir = path.join(process.cwd(), "prisma/migrations");
      const prior = readdirSync(migrationsDir).filter((name) => name !== "migration_lock.toml" && name < PHASE3).sort();
      expect(prior).toContain("20261010020000_pipeline_contracts");
      for (const directory of prior) {
        await client.query(readFileSync(path.join(migrationsDir, directory, "migration.sql"), "utf8"));
      }

      const userId = "11111111-1111-4111-8111-111111111111";
      const managerId = "22222222-2222-4222-8222-222222222222";
      const issuedCaseId = "33333333-3333-4333-8333-333333333333";
      const resolvedCaseId = "44444444-4444-4444-8444-444444444444";
      const recommendationId = "55555555-5555-4555-8555-555555555555";
      const createdAt = new Date("2026-03-03T10:00:00.000Z");
      const payload = { referenceNumber: "AE-P3-SEED", seeded: true };
      const hash = computeEventHash({ prevHash: GENESIS_HASH, payload, actorId: userId, seq: 1, createdAtIso: createdAt.toISOString() });

      await client.query(`INSERT INTO "User" (id, email, "displayName", locale, "globalRole", "createdAt") VALUES ($1, 'p3-seed-c@example.com', 'Seed C', 'fr-CA', 'COMPLAINANT', $3), ($2, 'p3-seed-m@example.com', 'Seed M', 'en-CA', 'CASE_MANAGER', $3)`, [userId, managerId, createdAt]);
      await client.query(`INSERT INTO "Case" (id, "referenceNumber", state, category, "disputeDescription", "complainantId", "respondentId", "caseManagerId", "createdAt") VALUES ($1, 'AE-P3-SEED', 'ISSUED', 'RETAIL', 'Seeded issued case.', $3, $3, $4, $5), ($2, 'AE-P3-DONE', 'RESOLVED_CONSENT', 'RETAIL', 'Seeded resolved case.', $3, $3, $4, $5)`, [issuedCaseId, resolvedCaseId, userId, managerId, createdAt]);
      await client.query(`INSERT INTO "Recommendation" (id, "caseId", version, status, explanation, "modelId", "promptVersion", "issuedById", "issuedAt") VALUES ($1, $2, 1, 'ISSUED', '{}'::jsonb, 'seed', 'seed', $3, $4)`, [recommendationId, issuedCaseId, managerId, createdAt]);
      await client.query(`UPDATE "Case" SET "currentRecommendationId" = $1 WHERE id = $2`, [recommendationId, issuedCaseId]);
      await client.query(`INSERT INTO "Event" (id, "caseId", seq, type, "actorId", payload, "prevHash", hash, "createdAt") VALUES ('66666666-6666-4666-8666-666666666666', $1, 1, 'CASE_CREATED', $2, $3::jsonb, $4, $5, $6)`, [issuedCaseId, userId, JSON.stringify(payload), GENESIS_HASH, hash, createdAt]);
      await client.query(`INSERT INTO "ReviewTrail" (id, "caseId", "reviewerId", action, rationale, "createdById") VALUES ('77777777-7777-4777-8777-777777777777', $1, $2, 'NOTED', 'seed note', $2)`, [issuedCaseId, managerId]);

      const beforeColumns = await client.query<{ table_name: string; column_name: string }>(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`);
      const beforeCases = (await client.query(`SELECT id, "referenceNumber", state, "currentRecommendationId" FROM "Case" ORDER BY id`)).rows;
      const beforeEvents = (await client.query(`SELECT id, seq, hash FROM "Event" ORDER BY seq`)).rows;

      await client.query(readFileSync(path.join(migrationsDir, PHASE3, "migration.sql"), "utf8"));

      const afterColumns = await client.query<{ table_name: string; column_name: string }>(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`);
      const afterKey = new Set(afterColumns.rows.map((row) => `${row.table_name}.${row.column_name}`));
      for (const row of beforeColumns.rows) {
        expect(afterKey.has(`${row.table_name}.${row.column_name}`), `missing ${row.table_name}.${row.column_name}`).toBe(true);
      }
      expect((await client.query(`SELECT id, "referenceNumber", state, "currentRecommendationId" FROM "Case" ORDER BY id`)).rows).toEqual(beforeCases);
      expect((await client.query(`SELECT id, seq, hash FROM "Event" ORDER BY seq`)).rows).toEqual(beforeEvents);

      // P3-D1: every pre-existing case keeps the consent-only path.
      const flags = (await client.query(`SELECT id, "consentOnlyResolution" FROM "Case" ORDER BY id`)).rows;
      expect(flags).toEqual([
        { id: issuedCaseId, consentOnlyResolution: true },
        { id: resolvedCaseId, consentOnlyResolution: true },
      ]);
      // Nobody is an approver until granted; the old review row keeps a null recommendation.
      expect((await client.query(`SELECT count(*)::int AS n FROM "User" WHERE "isApprover"`)).rows[0].n).toBe(0);
      expect((await client.query(`SELECT "recommendationId" FROM "ReviewTrail"`)).rows).toEqual([{ recommendationId: null }]);
      expect((await client.query(`SELECT count(*)::int AS n FROM "Contestation"`)).rows[0].n).toBe(0);

      // A case inserted after the migration needs approver sign-off.
      await client.query(`INSERT INTO "Case" (id, "referenceNumber", state, category, "disputeDescription", "complainantId", "respondentId") VALUES ('88888888-8888-4888-8888-888888888888', 'AE-P3-NEW', 'DRAFT', 'RETAIL', 'New case.', $1, $1)`, [userId]);
      expect((await client.query(`SELECT "consentOnlyResolution" FROM "Case" WHERE id = '88888888-8888-4888-8888-888888888888'`)).rows[0].consentOnlyResolution).toBe(false);

      // Check constraints: blank grounds and a RESPONDED row without a response are refused.
      await expect(client.query(`INSERT INTO "Contestation" (id, "caseId", "targetType", "targetId", grounds, "openedById") VALUES ('99999999-9999-4999-8999-999999999991', $1, 'CLAIM', $1, '   ', $2)`, [issuedCaseId, userId])).rejects.toThrow();
      await expect(client.query(`INSERT INTO "Contestation" (id, "caseId", "targetType", "targetId", grounds, status, "openedById") VALUES ('99999999-9999-4999-8999-999999999992', $1, 'CLAIM', $1, 'ok', 'RESPONDED', $2)`, [issuedCaseId, userId])).rejects.toThrow();
    } finally {
      await client.end();
    }
  }, 60_000);
});
