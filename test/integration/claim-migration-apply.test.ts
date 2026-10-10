import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";
import { GENESIS_HASH, computeEventHash } from "../../src/domain/events";

const PHASE1 = "20261009191500_traceable_core";
const APPLY_DB = "aequitas_phase1_apply_test";

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

describe("phase 1 migration applies on a database built from current main", () => {
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

  it("keeps seeded rows and adds tables without dropping columns", async () => {
    await resetDatabase();
    const client = new pg.Client({ connectionString: applyUrl() });
    await client.connect();
    try {
      const migrationsDir = path.join(process.cwd(), "prisma/migrations");
      const prior = readdirSync(migrationsDir).filter((name) => name !== "migration_lock.toml" && name < PHASE1).sort();
      expect(prior.length).toBeGreaterThan(0);
      for (const directory of prior) {
        const sql = readFileSync(path.join(migrationsDir, directory, "migration.sql"), "utf8");
        await client.query(sql);
      }

      const userId = "11111111-1111-4111-8111-111111111111";
      const otherId = "22222222-2222-4222-8222-222222222222";
      const caseId = "33333333-3333-4333-8333-333333333333";
      const evidenceId = "44444444-4444-4444-8444-444444444444";
      const statementId = "55555555-5555-4555-8555-555555555555";
      const eventId = "66666666-6666-4666-8666-666666666666";
      const createdAt = new Date("2026-02-02T15:04:05.000Z");
      const payload = { referenceNumber: "AE-MIG-SEED", seeded: true };
      const hash = computeEventHash({ prevHash: GENESIS_HASH, payload, actorId: userId, seq: 1, createdAtIso: createdAt.toISOString() });

      await client.query(`INSERT INTO "User" (id, email, "displayName", locale, "globalRole", "createdAt") VALUES ($1, $2, $3, 'fr-CA', 'COMPLAINANT', $4), ($5, $6, $7, 'en-CA', 'RESPONDENT', $4)`, [userId, "mig-seed-complainant@example.com", "Mig Complainant", createdAt, otherId, "mig-seed-respondent@example.com", "Mig Respondent"]);
      await client.query(`INSERT INTO "ConsentStatementVersion" (id, version, locale, body, "effectiveFrom") VALUES ($1, 1, 'fr-CA', $2, $3)`, [statementId, "Seeded consent statement for the migration test.", createdAt]);
      await client.query(`INSERT INTO "Case" (id, "referenceNumber", state, category, "disputeDescription", "complainantId", "respondentId", "createdAt") VALUES ($1, 'AE-MIG-SEED', 'OPEN', 'RETAIL', $2, $3, $4, $5)`, [caseId, "Seeded dispute that must survive the additive migration.", userId, otherId, createdAt]);
      await client.query(`INSERT INTO "EvidenceItem" (id, "caseId", "submittedById", kind, title, "storageKey", sha256, "byteSize", "mimeType", "scanStatus", simulated, "createdAt") VALUES ($1, $2, $3, 'DOCUMENT', 'Seeded note', $4, $5, 4, 'text/plain', 'CLEAN', true, $6)`, [evidenceId, caseId, userId, `mig-seed-${evidenceId}`, "b".repeat(64), createdAt]);
      await client.query(`INSERT INTO "Event" (id, "caseId", seq, type, "actorId", payload, "prevHash", hash, "createdAt") VALUES ($1, $2, 1, 'CASE_CREATED', $3, $4::jsonb, $5, $6, $7)`, [eventId, caseId, userId, JSON.stringify(payload), GENESIS_HASH, hash, createdAt]);

      const beforeColumns = await client.query<{ table_name: string; column_name: string }>(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`);
      const beforeRows = {
        users: (await client.query(`SELECT id, email, "globalRole" FROM "User" ORDER BY email`)).rows,
        statements: (await client.query(`SELECT id, body FROM "ConsentStatementVersion"`)).rows,
        cases: (await client.query(`SELECT id, "referenceNumber", state, "disputeDescription" FROM "Case"`)).rows,
        evidence: (await client.query(`SELECT id, title, "storageKey" FROM "EvidenceItem"`)).rows,
        events: (await client.query(`SELECT id, type, hash, seq FROM "Event"`)).rows,
      };

      const phase1 = readFileSync(path.join(migrationsDir, PHASE1, "migration.sql"), "utf8");
      await client.query(phase1);

      const afterColumns = await client.query<{ table_name: string; column_name: string }>(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`);
      const afterKey = new Set(afterColumns.rows.map((row) => `${row.table_name}.${row.column_name}`));
      for (const row of beforeColumns.rows) {
        expect(afterKey.has(`${row.table_name}.${row.column_name}`), `missing ${row.table_name}.${row.column_name}`).toBe(true);
      }
      expect((await client.query(`SELECT id, email, "globalRole" FROM "User" ORDER BY email`)).rows).toEqual(beforeRows.users);
      expect((await client.query(`SELECT id, body FROM "ConsentStatementVersion"`)).rows).toEqual(beforeRows.statements);
      expect((await client.query(`SELECT id, "referenceNumber", state, "disputeDescription" FROM "Case"`)).rows).toEqual(beforeRows.cases);
      expect((await client.query(`SELECT id, title, "storageKey" FROM "EvidenceItem"`)).rows).toEqual(beforeRows.evidence);
      expect((await client.query(`SELECT id, type, hash, seq FROM "Event"`)).rows).toEqual(beforeRows.events);

      for (const table of ["Source", "Claim", "ClaimEvidenceLink", "ClaimRelationship", "ReviewTrail"]) {
        expect(Number((await client.query(`SELECT count(*)::int AS n FROM "${table}"`)).rows[0].n)).toBe(0);
      }

      await client.query(`INSERT INTO "Source" (id, "caseId", kind, title, language, "evidenceItemId", "createdById") VALUES ($1, $2, 'EVIDENCE_ITEM', 'Seeded note as source', 'fr-CA', $3, $4)`, ["77777777-7777-4777-8777-777777777777", caseId, evidenceId, userId]);
      expect(Number((await client.query(`SELECT count(*)::int AS n FROM "EvidenceItem"`)).rows[0].n)).toBe(1);
      expect(Number((await client.query(`SELECT count(*)::int AS n FROM "Source"`)).rows[0].n)).toBe(1);
    } finally {
      await client.end();
    }
  }, 60_000);
});
