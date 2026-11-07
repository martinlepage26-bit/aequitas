-- Party-facing outcomes (Martin, 2026-10-20). Additive only: one new enum,
-- one new table, two EventType values. No existing table, column, or row
-- is dropped, renamed, or rewritten.

ALTER TYPE "EventType" ADD VALUE 'PARTY_OUTCOME_EDITED';
ALTER TYPE "EventType" ADD VALUE 'PARTY_OUTCOME_ISSUED';

CREATE TYPE "PartyOutcomeStatus" AS ENUM ('DRAFT', 'ISSUED');

CREATE TABLE "PartyOutcome" (
  "id" TEXT NOT NULL,
  "caseId" TEXT NOT NULL,
  "partyId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "status" "PartyOutcomeStatus" NOT NULL DEFAULT 'DRAFT',
  "body" TEXT NOT NULL,
  "locale" TEXT NOT NULL,
  "authoredById" TEXT NOT NULL,
  "issuedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PartyOutcome_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PartyOutcome_body_not_blank" CHECK (length(btrim("body")) > 0)
);

CREATE UNIQUE INDEX "PartyOutcome_caseId_partyId_version_key" ON "PartyOutcome"("caseId", "partyId", "version");
CREATE INDEX "PartyOutcome_caseId_partyId_status_idx" ON "PartyOutcome"("caseId", "partyId", "status");

ALTER TABLE "PartyOutcome" ADD CONSTRAINT "PartyOutcome_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PartyOutcome" ADD CONSTRAINT "PartyOutcome_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PartyOutcome" ADD CONSTRAINT "PartyOutcome_authoredById_fkey" FOREIGN KEY ("authoredById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
