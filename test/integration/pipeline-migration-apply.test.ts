import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";
import { GENESIS_HASH, computeEventHash } from "../../src/domain/events";

const PHASE2 = "20261010020000_pipeline_contracts";
const APPLY_DB = "aequitas_phase2_apply_test";

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

async function resetDatabase() {
  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  try {
    await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()", [APPLY_DB]);
    await admin.query(`DROP DATABASE IF EXISTS "${APPLY_DB}"`);
    await admin.query(`CREATE DATABASE "${APPLY_DB}"`);
  } finally {
    await admin.end();
  }
}

describe("phase 2 migration applies on a database that already has the traceable core", () => {
  afterAll(async () => {
    const admin = new pg.Client({ connectionString: adminUrl() });
    await admin.connect();
    try {
      await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()", [APPLY_DB]);
      await admin.query(`DROP DATABASE IF EXISTS "${APPLY_DB}"`);
    } finally {
      await admin.end();
    }
  });

  it("keeps seeded rows and adds pipeline tables without dropping columns", async () => {
    await resetDatabase();
    const client = new pg.Client({ connectionString: applyUrl() });
    await client.connect();
    try {
      const migrationsDir = path.join(process.cwd(), "prisma/migrations");
      const prior = readdirSync(migrationsDir).filter((name) => name !== "migration_lock.toml" && name < PHASE2).sort();
      expect(prior).toContain("20261009191500_traceable_core");
      for (const directory of prior) {
        await client.query(readFileSync(path.join(migrationsDir, directory, "migration.sql"), "utf8"));
      }

      const userId = "11111111-1111-4111-8111-111111111111";
      const otherId = "22222222-2222-4222-8222-222222222222";
      const caseId = "33333333-3333-4333-8333-333333333333";
      const sourceId = "77777777-7777-4777-8777-777777777777";
      const eventId = "66666666-6666-4666-8666-666666666666";
      const createdAt = new Date("2026-02-02T15:04:05.000Z");
      const payload = { referenceNumber: "AE-PIPE-SEED", seeded: true };
      const hash = computeEventHash({ prevHash: GENESIS_HASH, payload, actorId: userId, seq: 1, createdAtIso: createdAt.toISOString() });

      await client.query(`INSERT INTO "User" (id, email, "displayName", locale, "globalRole", "createdAt") VALUES ($1, $2, $3, 'fr-CA', 'COMPLAINANT', $4), ($5, $6, $7, 'en-CA', 'CASE_MANAGER', $4)`, [userId, "pipe-seed-complainant@example.com", "Pipe Complainant", createdAt, otherId, "pipe-seed-manager@example.com", "Pipe Manager"]);
      await client.query(`INSERT INTO "Case" (id, "referenceNumber", state, category, "disputeDescription", "complainantId", "respondentId", "createdAt") VALUES ($1, 'AE-PIPE-SEED', 'OPEN', 'RETAIL', $2, $3, $3, $4)`, [caseId, "Seeded dispute that must survive the pipeline migration.", userId, createdAt]);
      await client.query(`INSERT INTO "Source" (id, "caseId", kind, title, language, "createdById") VALUES ($1, $2, 'DOCUMENT', 'Seeded note', 'fr-CA', $3)`, [sourceId, caseId, otherId]);
      await client.query(`INSERT INTO "Event" (id, "caseId", seq, type, "actorId", payload, "prevHash", hash, "createdAt") VALUES ($1, $2, 1, 'CASE_CREATED', $3, $4::jsonb, $5, $6, $7)`, [eventId, caseId, userId, JSON.stringify(payload), GENESIS_HASH, hash, createdAt]);

      const beforeColumns = await client.query<{ table_name: string; column_name: string }>(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`);
      const beforeCase = (await client.query(`SELECT id, "referenceNumber", state FROM "Case"`)).rows;

      await client.query(readFileSync(path.join(migrationsDir, PHASE2, "migration.sql"), "utf8"));

      const afterColumns = await client.query<{ table_name: string; column_name: string }>(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`);
      const afterKey = new Set(afterColumns.rows.map((row) => `${row.table_name}.${row.column_name}`));
      for (const row of beforeColumns.rows) {
        expect(afterKey.has(`${row.table_name}.${row.column_name}`), `missing ${row.table_name}.${row.column_name}`).toBe(true);
      }
      expect((await client.query(`SELECT id, "referenceNumber", state FROM "Case"`)).rows).toEqual(beforeCase);
      expect((await client.query(`SELECT id, title, body FROM "Source"`)).rows).toEqual([{ id: sourceId, title: "Seeded note", body: null }]);
      for (const table of ["Assumption", "CasePipeline", "PipelineProposal", "ContextFactor", "SynthesisVersion"]) {
        expect(Number((await client.query(`SELECT count(*)::int AS n FROM "${table}"`)).rows[0].n)).toBe(0);
      }
    } finally {
      await client.end();
    }
  }, 60_000);
});
