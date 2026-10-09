-- Phase 1 traceable core. Additive only: new enums, new tables, new EventType
-- values. No existing table, column, or row is dropped, renamed, or rewritten.

ALTER TYPE "EventType" ADD VALUE 'SOURCE_RECORDED';
ALTER TYPE "EventType" ADD VALUE 'CLAIM_RECORDED';
ALTER TYPE "EventType" ADD VALUE 'CLAIM_UPDATED';
ALTER TYPE "EventType" ADD VALUE 'CLAIM_EVIDENCE_LINKED';
ALTER TYPE "EventType" ADD VALUE 'CLAIM_RELATIONSHIP_RECORDED';
ALTER TYPE "EventType" ADD VALUE 'REVIEW_RECORDED';

CREATE TYPE "ClaimType" AS ENUM ('FACTUAL', 'CAUSAL', 'MORAL', 'IDENTITY', 'POLICY', 'IMPACT_STATEMENT');
CREATE TYPE "ClaimConfidence" AS ENUM ('ESTABLISHED', 'PROBABLE', 'DISPUTED', 'UNKNOWN');
CREATE TYPE "ClaimStatus" AS ENUM ('OPEN', 'NEEDS_EVIDENCE', 'DISPUTED', 'MERGED', 'SUPERSEDED', 'WITHDRAWN');
CREATE TYPE "SourceKind" AS ENUM ('DOCUMENT', 'MESSAGE', 'TESTIMONY', 'POLICY', 'RECORD', 'URL', 'EVIDENCE_ITEM', 'STATUTE');
CREATE TYPE "SourceVisibility" AS ENUM ('CASE', 'RESTRICTED', 'REDACTED');
CREATE TYPE "ClaimLinkPredicate" AS ENUM ('ORIGINATES_FROM', 'SUPPORTS', 'CONTRADICTS', 'QUALIFIES');
CREATE TYPE "ClaimRelationPredicate" AS ENUM (
  'SUPPORTS', 'CONTRADICTS', 'QUALIFIES', 'INTERPRETS',
  'EXPERIENCED_BY', 'OCCURRED_BEFORE', 'ALLEGED_TO_HAVE_CONTRIBUTED_TO',
  'CONSISTENT_WITH', 'AMPLIFIED_BY', 'GOVERNED_BY',
  'REQUIRES_REVIEW', 'UNRESOLVED_WITH', 'PROPOSES_REPAIR_FOR',
  'CONTESTED_BY'
);
CREATE TYPE "ReviewAction" AS ENUM ('NOTED', 'EDITED', 'APPROVED', 'REJECTED', 'OVERRULED_CONTESTATION');

CREATE TABLE "Source" (
  "id" TEXT NOT NULL,
  "caseId" TEXT NOT NULL,
  "kind" "SourceKind" NOT NULL,
  "title" TEXT NOT NULL,
  "origin" TEXT,
  "obtainedVia" TEXT,
  "language" TEXT NOT NULL DEFAULT 'fr-CA',
  "sensitive" BOOLEAN NOT NULL DEFAULT false,
  "visibility" "SourceVisibility" NOT NULL DEFAULT 'CASE',
  "contentRef" TEXT,
  "citation" TEXT,
  "legalFramework" TEXT,
  "evidenceItemId" TEXT,
  "publishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdById" TEXT NOT NULL,
  "deletedAt" TIMESTAMP(3),
  "deletionReason" TEXT,
  CONSTRAINT "Source_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Source_statute_requires_citation" CHECK ("kind" <> 'STATUTE' OR char_length(btrim(COALESCE("citation", ''))) > 0),
  CONSTRAINT "Source_evidence_item_requires_reference" CHECK ("kind" <> 'EVIDENCE_ITEM' OR "evidenceItemId" IS NOT NULL)
);

CREATE TABLE "Claim" (
  "id" TEXT NOT NULL,
  "caseId" TEXT NOT NULL,
  "claimType" "ClaimType" NOT NULL,
  "text" TEXT NOT NULL,
  "confidence" "ClaimConfidence" NOT NULL DEFAULT 'UNKNOWN',
  "confidenceRationale" TEXT,
  "status" "ClaimStatus" NOT NULL DEFAULT 'NEEDS_EVIDENCE',
  "mergedIntoId" TEXT,
  "locale" TEXT NOT NULL DEFAULT 'fr-CA',
  "doNotSummarizeAsSettled" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdById" TEXT NOT NULL,
  "deletedAt" TIMESTAMP(3),
  "deletionReason" TEXT,
  CONSTRAINT "Claim_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Claim_uncertain_requires_rationale" CHECK (
    "confidence" NOT IN ('DISPUTED', 'UNKNOWN') OR char_length(btrim(COALESCE("confidenceRationale", ''))) > 0
  )
);

CREATE TABLE "ClaimEvidenceLink" (
  "id" TEXT NOT NULL,
  "claimId" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "predicate" "ClaimLinkPredicate" NOT NULL,
  "excerpt" TEXT NOT NULL,
  "rationale" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdById" TEXT NOT NULL,
  "deletedAt" TIMESTAMP(3),
  "deletionReason" TEXT,
  CONSTRAINT "ClaimEvidenceLink_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ClaimEvidenceLink_excerpt_not_blank" CHECK (char_length(btrim("excerpt")) > 0)
);

CREATE TABLE "ClaimRelationship" (
  "id" TEXT NOT NULL,
  "caseId" TEXT NOT NULL,
  "fromClaimId" TEXT NOT NULL,
  "toClaimId" TEXT NOT NULL,
  "predicate" "ClaimRelationPredicate" NOT NULL,
  "evidenceId" TEXT,
  "rationale" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdById" TEXT NOT NULL,
  "deletedAt" TIMESTAMP(3),
  "deletionReason" TEXT,
  CONSTRAINT "ClaimRelationship_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ClaimRelationship_distinct_claims" CHECK ("fromClaimId" <> "toClaimId")
);

CREATE TABLE "ReviewTrail" (
  "id" TEXT NOT NULL,
  "caseId" TEXT NOT NULL,
  "claimId" TEXT,
  "synthesisId" TEXT,
  "reviewerId" TEXT NOT NULL,
  "action" "ReviewAction" NOT NULL,
  "rationale" TEXT,
  "snapshot" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdById" TEXT NOT NULL,
  CONSTRAINT "ReviewTrail_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Source_caseId_createdAt_idx" ON "Source"("caseId", "createdAt");
CREATE INDEX "Claim_caseId_createdAt_idx" ON "Claim"("caseId", "createdAt");
CREATE INDEX "ClaimEvidenceLink_claimId_idx" ON "ClaimEvidenceLink"("claimId");
CREATE INDEX "ClaimEvidenceLink_sourceId_idx" ON "ClaimEvidenceLink"("sourceId");
CREATE INDEX "ClaimRelationship_caseId_createdAt_idx" ON "ClaimRelationship"("caseId", "createdAt");
CREATE INDEX "ReviewTrail_caseId_createdAt_idx" ON "ReviewTrail"("caseId", "createdAt");

ALTER TABLE "Source" ADD CONSTRAINT "Source_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Source" ADD CONSTRAINT "Source_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Source" ADD CONSTRAINT "Source_evidenceItemId_fkey" FOREIGN KEY ("evidenceItemId") REFERENCES "EvidenceItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Claim" ADD CONSTRAINT "Claim_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Claim" ADD CONSTRAINT "Claim_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Claim" ADD CONSTRAINT "Claim_mergedIntoId_fkey" FOREIGN KEY ("mergedIntoId") REFERENCES "Claim"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ClaimEvidenceLink" ADD CONSTRAINT "ClaimEvidenceLink_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "Claim"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ClaimEvidenceLink" ADD CONSTRAINT "ClaimEvidenceLink_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ClaimEvidenceLink" ADD CONSTRAINT "ClaimEvidenceLink_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ClaimRelationship" ADD CONSTRAINT "ClaimRelationship_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ClaimRelationship" ADD CONSTRAINT "ClaimRelationship_fromClaimId_fkey" FOREIGN KEY ("fromClaimId") REFERENCES "Claim"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ClaimRelationship" ADD CONSTRAINT "ClaimRelationship_toClaimId_fkey" FOREIGN KEY ("toClaimId") REFERENCES "Claim"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ClaimRelationship" ADD CONSTRAINT "ClaimRelationship_evidenceId_fkey" FOREIGN KEY ("evidenceId") REFERENCES "Source"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ClaimRelationship" ADD CONSTRAINT "ClaimRelationship_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ReviewTrail" ADD CONSTRAINT "ReviewTrail_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReviewTrail" ADD CONSTRAINT "ReviewTrail_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "Claim"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReviewTrail" ADD CONSTRAINT "ReviewTrail_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReviewTrail" ADD CONSTRAINT "ReviewTrail_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
