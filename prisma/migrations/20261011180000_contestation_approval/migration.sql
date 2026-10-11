-- Phase 3a/3b: contestation and approver sign-off. Additive only: new enums,
-- one new table, new EventType values, new columns. No existing table,
-- column, or row is dropped, renamed, or rewritten.

ALTER TYPE "EventType" ADD VALUE 'CONTESTATION_OPENED';
ALTER TYPE "EventType" ADD VALUE 'CONTESTATION_RESPONDED';
ALTER TYPE "EventType" ADD VALUE 'CONTESTATION_OVERRULED';
ALTER TYPE "EventType" ADD VALUE 'CONTESTATION_WITHDRAWN';
ALTER TYPE "EventType" ADD VALUE 'RESOLUTION_APPROVED';

CREATE TYPE "ContestationStatus" AS ENUM ('OPEN', 'RESPONDED', 'OVERRULED', 'WITHDRAWN');
CREATE TYPE "ContestationTarget" AS ENUM ('CLAIM', 'SYNTHESIS', 'PROPOSAL', 'RECOMMENDATION');

-- P3-D1 (Martin, 2026-10-11): cases that exist before this migration keep the
-- consent-only resolution path. ADD COLUMN ... DEFAULT true marks every
-- existing row true in one step; the default is then switched to false so
-- every case created afterwards needs approver sign-off before resolution.
ALTER TABLE "Case" ADD COLUMN "consentOnlyResolution" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Case" ALTER COLUMN "consentOnlyResolution" SET DEFAULT false;

-- P3-D2: approver is a capability on a case-manager account, granted by
-- scripts/grant-approver.ts. Nobody holds it after this migration.
ALTER TABLE "User" ADD COLUMN "isApprover" BOOLEAN NOT NULL DEFAULT false;

-- Approver sign-off binds to one recommendation version.
ALTER TABLE "ReviewTrail" ADD COLUMN "recommendationId" TEXT;
ALTER TABLE "ReviewTrail" ADD CONSTRAINT "ReviewTrail_recommendationId_fkey"
  FOREIGN KEY ("recommendationId") REFERENCES "Recommendation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "ReviewTrail_recommendationId_idx" ON "ReviewTrail"("recommendationId");

CREATE TABLE "Contestation" (
  "id" TEXT NOT NULL,
  "caseId" TEXT NOT NULL,
  "targetType" "ContestationTarget" NOT NULL,
  "targetId" TEXT NOT NULL,
  "grounds" TEXT NOT NULL,
  "status" "ContestationStatus" NOT NULL DEFAULT 'OPEN',
  "openedById" TEXT NOT NULL,
  "response" TEXT,
  "respondedById" TEXT,
  "respondedAt" TIMESTAMP(3),
  "overruleReason" TEXT,
  "overruledById" TEXT,
  "overruledAt" TIMESTAMP(3),
  "withdrawnAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "Contestation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Contestation_grounds_not_blank" CHECK (length(btrim("grounds")) > 0),
  CONSTRAINT "Contestation_response_recorded" CHECK ("status" <> 'RESPONDED' OR ("response" IS NOT NULL AND length(btrim("response")) > 0 AND "respondedById" IS NOT NULL)),
  CONSTRAINT "Contestation_overrule_reason_recorded" CHECK ("status" <> 'OVERRULED' OR ("overruleReason" IS NOT NULL AND length(btrim("overruleReason")) > 0 AND "overruledById" IS NOT NULL))
);

CREATE INDEX "Contestation_caseId_status_idx" ON "Contestation"("caseId", "status");

ALTER TABLE "Contestation" ADD CONSTRAINT "Contestation_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Contestation" ADD CONSTRAINT "Contestation_openedById_fkey" FOREIGN KEY ("openedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Contestation" ADD CONSTRAINT "Contestation_respondedById_fkey" FOREIGN KEY ("respondedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Contestation" ADD CONSTRAINT "Contestation_overruledById_fkey" FOREIGN KEY ("overruledById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
