import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = path.join(process.cwd(), "prisma/migrations/20261009191500_traceable_core/migration.sql");

const FORBIDDEN = [
  /\bDROP\s+(TABLE|COLUMN|TYPE|INDEX|CONSTRAINT|SCHEMA|DATABASE)\b/i,
  /\bRENAME\s+(TO|COLUMN)\b/i,
  /\bALTER\s+TABLE\b[^;]*\bRENAME\b/i,
  /\bDELETE\s+FROM\b/i,
  /\bTRUNCATE\b/i,
  /\bUPDATE\s+"/,
  /\bALTER\s+COLUMN\b[^;]*\bTYPE\b/i,
];

describe("phase 1 migration is additive only", () => {
  const sql = readFileSync(migrationPath, "utf8");

  it("does not drop, rename, or rewrite existing data", () => {
    for (const pattern of FORBIDDEN) {
      expect(sql).not.toMatch(pattern);
    }
  });

  it("adds sources, claims, evidence links, relationships, and review trail", () => {
    for (const table of ["Source", "Claim", "ClaimEvidenceLink", "ClaimRelationship", "ReviewTrail"]) {
      expect(sql).toContain(`CREATE TABLE "${table}"`);
    }
    expect(sql).toContain('"excerpt" TEXT NOT NULL');
    expect(sql).toContain("ClaimEvidenceLink_excerpt_not_blank");
    for (const eventType of ["SOURCE_RECORDED", "CLAIM_RECORDED", "CLAIM_UPDATED", "CLAIM_EVIDENCE_LINKED", "CLAIM_RELATIONSHIP_RECORDED", "REVIEW_RECORDED"]) {
      expect(sql).toContain(`ADD VALUE '${eventType}'`);
    }
  });
});
