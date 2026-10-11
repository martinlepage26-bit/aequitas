import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = path.join(process.cwd(), "prisma/migrations/20261011180000_contestation_approval/migration.sql");

const FORBIDDEN = [
  /\bDROP\s+(TABLE|COLUMN|TYPE|INDEX|CONSTRAINT|SCHEMA|DATABASE)\b/i,
  /\bRENAME\s+(TO|COLUMN)\b/i,
  /\bALTER\s+TABLE\b[^;]*\bRENAME\b/i,
  /\bDELETE\s+FROM\b/i,
  /\bTRUNCATE\b/i,
  /\bUPDATE\s+"/,
  /\bALTER\s+COLUMN\b[^;]*\bTYPE\b/i,
];

describe("phase 3 migration is additive only", () => {
  const sql = readFileSync(migrationPath, "utf8");

  it("does not drop, rename, or rewrite existing data", () => {
    for (const pattern of FORBIDDEN) expect(sql).not.toMatch(pattern);
  });

  it("adds the contestation table, the consent-only flag, the approver flag, and the five event types", () => {
    expect(sql).toContain('CREATE TABLE "Contestation"');
    expect(sql).toContain('ADD COLUMN "consentOnlyResolution" BOOLEAN NOT NULL DEFAULT true');
    expect(sql).toContain('ALTER COLUMN "consentOnlyResolution" SET DEFAULT false');
    expect(sql).toContain('ADD COLUMN "isApprover" BOOLEAN NOT NULL DEFAULT false');
    expect(sql).toContain('ADD COLUMN "recommendationId" TEXT');
    for (const eventType of ["CONTESTATION_OPENED", "CONTESTATION_RESPONDED", "CONTESTATION_OVERRULED", "CONTESTATION_WITHDRAWN", "RESOLUTION_APPROVED"]) {
      expect(sql).toContain(`ADD VALUE '${eventType}'`);
    }
  });
});
