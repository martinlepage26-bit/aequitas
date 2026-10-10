-- Phase 2 pipeline contracts. Additive only: new enums, new tables, new
-- EventType values, one nullable column on Source, and a foreign key from
-- the already-nullable ReviewTrail.synthesisId. No existing table, column,
-- or row is dropped, renamed, or rewritten.

ALTER TYPE "EventType" ADD VALUE 'ASSUMPTION_RECORDED';
ALTER TYPE "EventType" ADD VALUE 'ASSUMPTION_ACKNOWLEDGED';
ALTER TYPE "EventType" ADD VALUE 'ASSUMPTION_CHALLENGED';
ALTER TYPE "EventType" ADD VALUE 'ASSUMPTION_REVISED';
ALTER TYPE "EventType" ADD VALUE 'ASSUMPTION_ADDED_MID_CASE';
ALTER TYPE "EventType" ADD VALUE 'PIPELINE_RETURNED';
ALTER TYPE "EventType" ADD VALUE 'PROPOSAL_RECORDED';
ALTER TYPE "EventType" ADD VALUE 'PROPOSAL_ACCEPTED';
ALTER TYPE "EventType" ADD VALUE 'PROPOSAL_REJECTED';
ALTER TYPE "EventType" ADD VALUE 'CONTEXT_FACTOR_RECORDED';
ALTER TYPE "EventType" ADD VALUE 'SYNTHESIS_RECORDED';
ALTER TYPE "EventType" ADD VALUE 'SYNTHESIS_REJECTED';

CREATE TYPE "AssumptionOrigin" AS ENUM ('CASE_FRAMING', 'PARTY_STATEMENT', 'ANALYST_NOTE', 'MID_CASE');
CREATE TYPE "AssumptionStatus" AS ENUM ('PROPOSED', 'ACKNOWLEDGED', 'CHALLENGED', 'REVISED');
CREATE TYPE "PipelineStageName" AS ENUM ('EPOCHE', 'CLAIM_DECOMPOSITION', 'CONTEXT_MAPPING', 'SYNTHESIS');
CREATE TYPE "ProposalKind" AS ENUM ('CLAIM', 'CONTEXT_FACTOR');
CREATE TYPE "ProposalStatus" AS ENUM ('PROPOSED', 'ACCEPTED', 'REJECTED');
CREATE TYPE "ContextFactorType" AS ENUM ('POLICY_VS_PRACTICE', 'INTERFACES_VS_DEPENDENCIES', 'AUTHORITY_VS_IMPLEMENTATION');
CREATE TYPE "GapDiagnosis" AS ENUM ('ADAPTIVE', 'PROTECTIVE', 'EVASIVE', 'FRAUDULENT', 'NO_GAP_FOUND');

ALTER TABLE "Source" ADD COLUMN "body" TEXT;

CREATE TABLE "Assumption" (
  "id" TEXT NOT NULL,
  "caseId" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "origin" "AssumptionOrigin" NOT NULL,
  "status" "AssumptionStatus" NOT NULL DEFAULT 'PROPOSED',
  "createdById" TEXT NOT NULL,
  "acknowledgedById" TEXT,
  "acknowledgedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt" TIMESTAMP(3),
  CONSTRAINT "Assumption_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Assumption_text_not_blank" CHECK (length(btrim("text")) > 0)
);

CREATE TABLE "CasePipeline" (
  "caseId" TEXT NOT NULL,
  "stage" "PipelineStageName" NOT NULL DEFAULT 'EPOCHE',
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CasePipeline_pkey" PRIMARY KEY ("caseId")
);

CREATE TABLE "PipelineProposal" (
  "id" TEXT NOT NULL,
  "caseId" TEXT NOT NULL,
  "kind" "ProposalKind" NOT NULL,
  "status" "ProposalStatus" NOT NULL DEFAULT 'PROPOSED',
  "payload" JSONB NOT NULL,
  "modelId" TEXT NOT NULL,
  "promptVersion" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reviewedById" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "acceptedClaimId" TEXT,
  CONSTRAINT "PipelineProposal_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ContextFactor" (
  "id" TEXT NOT NULL,
  "caseId" TEXT NOT NULL,
  "factorType" "ContextFactorType" NOT NULL,
  "description" TEXT NOT NULL,
  "gapMap" JSONB NOT NULL,
  "diagnosis" "GapDiagnosis" NOT NULL,
  "evidenceId" TEXT,
  "proposalId" TEXT,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt" TIMESTAMP(3),
  CONSTRAINT "ContextFactor_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ContextFactor_description_not_blank" CHECK (length(btrim("description")) > 0)
);

CREATE TABLE "SynthesisVersion" (
  "id" TEXT NOT NULL,
  "caseId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "sections" JSONB NOT NULL,
  "sentenceMap" JSONB NOT NULL,
  "diagE" TEXT NOT NULL,
  "diagP" TEXT NOT NULL,
  "diagC" TEXT NOT NULL,
  "modelId" TEXT,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SynthesisVersion_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Assumption_caseId_createdAt_idx" ON "Assumption"("caseId", "createdAt");
CREATE INDEX "PipelineProposal_caseId_createdAt_idx" ON "PipelineProposal"("caseId", "createdAt");
CREATE INDEX "ContextFactor_caseId_createdAt_idx" ON "ContextFactor"("caseId", "createdAt");
CREATE UNIQUE INDEX "ContextFactor_proposalId_key" ON "ContextFactor"("proposalId");
CREATE INDEX "SynthesisVersion_caseId_createdAt_idx" ON "SynthesisVersion"("caseId", "createdAt");
CREATE UNIQUE INDEX "SynthesisVersion_caseId_version_key" ON "SynthesisVersion"("caseId", "version");

ALTER TABLE "Assumption" ADD CONSTRAINT "Assumption_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Assumption" ADD CONSTRAINT "Assumption_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Assumption" ADD CONSTRAINT "Assumption_acknowledgedById_fkey" FOREIGN KEY ("acknowledgedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CasePipeline" ADD CONSTRAINT "CasePipeline_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PipelineProposal" ADD CONSTRAINT "PipelineProposal_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PipelineProposal" ADD CONSTRAINT "PipelineProposal_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ContextFactor" ADD CONSTRAINT "ContextFactor_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ContextFactor" ADD CONSTRAINT "ContextFactor_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ContextFactor" ADD CONSTRAINT "ContextFactor_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "PipelineProposal"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SynthesisVersion" ADD CONSTRAINT "SynthesisVersion_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SynthesisVersion" ADD CONSTRAINT "SynthesisVersion_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReviewTrail" ADD CONSTRAINT "ReviewTrail_synthesisId_fkey" FOREIGN KEY ("synthesisId") REFERENCES "SynthesisVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
