import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = path.join(process.cwd(), "prisma/migrations/20261010020000_pipeline_contracts/migration.sql");

const FORBIDDEN = [
  /\bDROP\s+(TABLE|COLUMN|TYPE|INDEX|CONSTRAINT|SCHEMA|DATABASE)\b/i,
  /\bRENAME\s+(TO|COLUMN)\b/i,
  /\bALTER\s+TABLE\b[^;]*\bRENAME\b/i,
  /\bDELETE\s+FROM\b/i,
  /\bTRUNCATE\b/i,
  /\bUPDATE\s+"/,
  /\bALTER\s+COLUMN\b[^;]*\bTYPE\b/i,
];

describe("phase 2 migration is additive only", () => {
  const sql = readFileSync(migrationPath, "utf8");

  it("does not drop, rename, or rewrite existing data", () => {
    for (const pattern of FORBIDDEN) {
      expect(sql).not.toMatch(pattern);
    }
  });

  it("adds the ledger, proposals, context factors, and synthesis versions", () => {
    for (const table of ["Assumption", "CasePipeline", "PipelineProposal", "ContextFactor", "SynthesisVersion"]) {
      expect(sql).toContain(`CREATE TABLE "${table}"`);
    }
    expect(sql).toContain('ADD COLUMN "body" TEXT');
    for (const eventType of [
      "ASSUMPTION_RECORDED",
      "ASSUMPTION_ACKNOWLEDGED",
      "ASSUMPTION_ADDED_MID_CASE",
      "PIPELINE_RETURNED",
      "PROPOSAL_RECORDED",
      "PROPOSAL_ACCEPTED",
      "SYNTHESIS_RECORDED",
      "SYNTHESIS_REJECTED",
    ]) {
      expect(sql).toContain(`ADD VALUE '${eventType}'`);
    }
  });
});
