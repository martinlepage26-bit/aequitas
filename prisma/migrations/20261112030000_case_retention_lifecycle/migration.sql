-- CreateEnum
CREATE TYPE "CaseOperationStatus" AS ENUM ('ACTIVE', 'SUCCEEDED', 'UNCERTAIN', 'RESOLVED');

-- CreateEnum
CREATE TYPE "CaseDeletionStatus" AS ENUM ('REQUESTED', 'APPROVED', 'FROZEN', 'ERASING', 'LOCAL_PURGED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "RetentionHoldState" AS ENUM ('UNKNOWN', 'CLEAR', 'HELD');

-- CreateEnum
CREATE TYPE "DeletionCopyStatus" AS ENUM ('PENDING', 'VERIFIED_DELETED', 'VERIFIED_ABSENT', 'OUTSIDE_CONTROL');

-- AlterTable
ALTER TABLE "Case" ADD COLUMN     "deletionStartedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "CaseOperation" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "storageKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "CaseOperationStatus" NOT NULL DEFAULT 'ACTIVE',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "resolutionEvidenceDigest" TEXT,

    CONSTRAINT "CaseOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CaseDeletion" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "eligibleAt" TIMESTAMP(3) NOT NULL,
    "status" "CaseDeletionStatus" NOT NULL DEFAULT 'REQUESTED',
    "holdState" "RetentionHoldState" NOT NULL DEFAULT 'UNKNOWN',
    "holdEvidenceDigest" TEXT,
    "requestedById" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "approvalDigest" TEXT,
    "frozenAt" TIMESTAMP(3),
    "inventoryAt" TIMESTAMP(3),
    "localPurgedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "CaseDeletion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CaseDeletionObject" (
    "id" TEXT NOT NULL,
    "deletionId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "erasedAt" TIMESTAMP(3),
    "backend" TEXT,
    "deletedVersions" INTEGER,

    CONSTRAINT "CaseDeletionObject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CaseDeletionCopy" (
    "id" TEXT NOT NULL,
    "deletionId" TEXT NOT NULL,
    "store" TEXT NOT NULL,
    "status" "DeletionCopyStatus" NOT NULL DEFAULT 'PENDING',
    "evidenceDigest" TEXT,
    "attestedById" TEXT,
    "attestedAt" TIMESTAMP(3),

    CONSTRAINT "CaseDeletionCopy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CaseDeletionDecision" (
    "id" TEXT NOT NULL,
    "deletionId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "evidenceDigest" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CaseDeletionDecision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CaseOperation_caseId_status_idx" ON "CaseOperation"("caseId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CaseDeletion_caseId_key" ON "CaseDeletion"("caseId");

-- CreateIndex
CREATE UNIQUE INDEX "CaseDeletionObject_deletionId_storageKey_key" ON "CaseDeletionObject"("deletionId", "storageKey");

-- CreateIndex
CREATE UNIQUE INDEX "CaseDeletionCopy_deletionId_store_key" ON "CaseDeletionCopy"("deletionId", "store");

-- CreateIndex
CREATE INDEX "CaseDeletionDecision_deletionId_createdAt_idx" ON "CaseDeletionDecision"("deletionId", "createdAt");

-- AddForeignKey
ALTER TABLE "CaseDeletionObject" ADD CONSTRAINT "CaseDeletionObject_deletionId_fkey" FOREIGN KEY ("deletionId") REFERENCES "CaseDeletion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseDeletionCopy" ADD CONSTRAINT "CaseDeletionCopy_deletionId_fkey" FOREIGN KEY ("deletionId") REFERENCES "CaseDeletion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseDeletionDecision" ADD CONSTRAINT "CaseDeletionDecision_deletionId_fkey" FOREIGN KEY ("deletionId") REFERENCES "CaseDeletion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CaseDeletion" ADD COLUMN "erasedObjectCount" INTEGER NOT NULL DEFAULT 0;

-- These checks are ordinary-runtime barriers. There are no caller-controlled
-- GUCs, disabled triggers, session_replication_role or timer-expired leases.
CREATE FUNCTION public.retention_check_case(p_case text) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  PERFORM 1 FROM public."Case" WHERE id = p_case FOR UPDATE;
  IF EXISTS (SELECT 1 FROM public."Case" WHERE id=p_case AND "deletionStartedAt" IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public."CaseDeletion" WHERE "caseId"=p_case AND "localPurgedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'CASE_DELETION_FROZEN';
  END IF;
END $$;

CREATE FUNCTION public.retention_write_barrier() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE v jsonb; c text;
BEGIN
  IF current_user = 'aequitas_erasure_owner' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  -- Check both parents when an UPDATE attempts to move a row between cases.
  FOR v IN SELECT x FROM unnest(CASE WHEN TG_OP='INSERT' THEN ARRAY[to_jsonb(NEW)]
    WHEN TG_OP='DELETE' THEN ARRAY[to_jsonb(OLD)] ELSE ARRAY[to_jsonb(OLD),to_jsonb(NEW)] END) x LOOP
    IF TG_TABLE_NAME='Case' THEN c:=v->>'id';
    ELSIF TG_TABLE_NAME='PartyOutcomeCitation' THEN
      SELECT "caseId" INTO c FROM public."PartyOutcome" WHERE id=v->>'partyOutcomeId';
      PERFORM public.retention_check_case(c);
      SELECT "caseId" INTO c FROM public."EvidenceItem" WHERE id=v->>'evidenceItemId';
    ELSIF TG_TABLE_NAME='ClaimEvidenceLink' THEN
      SELECT "caseId" INTO c FROM public."Claim" WHERE id=v->>'claimId';
      PERFORM public.retention_check_case(c);
      SELECT "caseId" INTO c FROM public."Source" WHERE id=v->>'sourceId';
    ELSE c:=v->>'caseId'; END IF;
    PERFORM public.retention_check_case(c);
  END LOOP;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE TRIGGER retention_barrier BEFORE INSERT OR UPDATE OR DELETE ON public."Case" FOR EACH ROW EXECUTE FUNCTION public.retention_write_barrier();
CREATE TRIGGER retention_barrier BEFORE INSERT OR UPDATE OR DELETE ON public."EvidenceItem" FOR EACH ROW EXECUTE FUNCTION public.retention_write_barrier();
CREATE TRIGGER retention_barrier BEFORE INSERT OR UPDATE OR DELETE ON public."PositionStatement" FOR EACH ROW EXECUTE FUNCTION public.retention_write_barrier();
CREATE TRIGGER retention_barrier BEFORE INSERT OR UPDATE OR DELETE ON public."ChronologyEntry" FOR EACH ROW EXECUTE FUNCTION public.retention_write_barrier();
CREATE TRIGGER retention_barrier BEFORE INSERT OR UPDATE OR DELETE ON public."Recommendation" FOR EACH ROW EXECUTE FUNCTION public.retention_write_barrier();
CREATE TRIGGER retention_barrier BEFORE INSERT OR UPDATE OR DELETE ON public."PartyOutcome" FOR EACH ROW EXECUTE FUNCTION public.retention_write_barrier();
CREATE TRIGGER retention_barrier BEFORE INSERT OR UPDATE OR DELETE ON public."ConsentRecord" FOR EACH ROW EXECUTE FUNCTION public.retention_write_barrier();
CREATE TRIGGER retention_barrier BEFORE INSERT OR UPDATE OR DELETE ON public."CoiDeclaration" FOR EACH ROW EXECUTE FUNCTION public.retention_write_barrier();
CREATE TRIGGER retention_barrier BEFORE INSERT OR UPDATE OR DELETE ON public."CaseDetailsRevision" FOR EACH ROW EXECUTE FUNCTION public.retention_write_barrier();
CREATE TRIGGER retention_barrier BEFORE INSERT OR UPDATE OR DELETE ON public."Event" FOR EACH ROW EXECUTE FUNCTION public.retention_write_barrier();
CREATE TRIGGER retention_barrier BEFORE INSERT OR UPDATE OR DELETE ON public."ExportBundle" FOR EACH ROW EXECUTE FUNCTION public.retention_write_barrier();
CREATE TRIGGER retention_barrier BEFORE INSERT OR UPDATE OR DELETE ON public."Notification" FOR EACH ROW EXECUTE FUNCTION public.retention_write_barrier();
CREATE TRIGGER retention_barrier BEFORE INSERT OR UPDATE OR DELETE ON public."Source" FOR EACH ROW EXECUTE FUNCTION public.retention_write_barrier();
CREATE TRIGGER retention_barrier BEFORE INSERT OR UPDATE OR DELETE ON public."Claim" FOR EACH ROW EXECUTE FUNCTION public.retention_write_barrier();
CREATE TRIGGER retention_barrier BEFORE INSERT OR UPDATE OR DELETE ON public."ClaimRelationship" FOR EACH ROW EXECUTE FUNCTION public.retention_write_barrier();
CREATE TRIGGER retention_barrier BEFORE INSERT OR UPDATE OR DELETE ON public."ReviewTrail" FOR EACH ROW EXECUTE FUNCTION public.retention_write_barrier();
CREATE TRIGGER retention_barrier BEFORE INSERT OR UPDATE OR DELETE ON public."Assumption" FOR EACH ROW EXECUTE FUNCTION public.retention_write_barrier();
CREATE TRIGGER retention_barrier BEFORE INSERT OR UPDATE OR DELETE ON public."CasePipeline" FOR EACH ROW EXECUTE FUNCTION public.retention_write_barrier();
CREATE TRIGGER retention_barrier BEFORE INSERT OR UPDATE OR DELETE ON public."PipelineProposal" FOR EACH ROW EXECUTE FUNCTION public.retention_write_barrier();
CREATE TRIGGER retention_barrier BEFORE INSERT OR UPDATE OR DELETE ON public."ContextFactor" FOR EACH ROW EXECUTE FUNCTION public.retention_write_barrier();
CREATE TRIGGER retention_barrier BEFORE INSERT OR UPDATE OR DELETE ON public."SynthesisVersion" FOR EACH ROW EXECUTE FUNCTION public.retention_write_barrier();
CREATE TRIGGER retention_barrier BEFORE INSERT OR UPDATE OR DELETE ON public."Contestation" FOR EACH ROW EXECUTE FUNCTION public.retention_write_barrier();
CREATE TRIGGER retention_barrier BEFORE INSERT OR UPDATE OR DELETE ON public."PartyOutcomeCitation" FOR EACH ROW EXECUTE FUNCTION public.retention_write_barrier();
CREATE TRIGGER retention_barrier BEFORE INSERT OR UPDATE OR DELETE ON public."ClaimEvidenceLink" FOR EACH ROW EXECUTE FUNCTION public.retention_write_barrier();

-- Append-only still applies to all normal application statements. Only the
-- NOLOGIN owner of the separately granted whole-case procedure may erase.
CREATE OR REPLACE FUNCTION public.prevent_event_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' AND current_user='aequitas_erasure_owner' THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'Event table is append-only';
END $$;
CREATE OR REPLACE FUNCTION public.prevent_chronology_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' AND current_user='aequitas_erasure_owner' THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'Chronology entries are append-only';
END $$;
CREATE FUNCTION public.retention_decisions_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Retention decisions are append-only'; END $$;
CREATE TRIGGER retention_decisions_append_only BEFORE UPDATE OR DELETE ON public."CaseDeletionDecision"
 FOR EACH ROW EXECUTE FUNCTION public.retention_decisions_immutable();

CREATE FUNCTION public.retention_assert_links(p_case text) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
 IF EXISTS (SELECT 1 FROM public."Source" a JOIN public."EvidenceItem" b ON a."evidenceItemId"=b.id WHERE a."caseId"<>b."caseId" AND (a."caseId"=p_case OR b."caseId"=p_case)) THEN RAISE EXCEPTION 'CROSS_CASE_REFERENCE'; END IF;
 IF EXISTS (SELECT 1 FROM public."Claim" a JOIN public."Claim" b ON a."mergedIntoId"=b.id WHERE a."caseId"<>b."caseId" AND (a."caseId"=p_case OR b."caseId"=p_case)) THEN RAISE EXCEPTION 'CROSS_CASE_REFERENCE'; END IF;
 IF EXISTS (SELECT 1 FROM public."ClaimRelationship" a JOIN public."Claim" b ON a."fromClaimId"=b.id WHERE a."caseId"<>b."caseId" AND (a."caseId"=p_case OR b."caseId"=p_case)) THEN RAISE EXCEPTION 'CROSS_CASE_REFERENCE'; END IF;
 IF EXISTS (SELECT 1 FROM public."ClaimRelationship" a JOIN public."Claim" b ON a."toClaimId"=b.id WHERE a."caseId"<>b."caseId" AND (a."caseId"=p_case OR b."caseId"=p_case)) THEN RAISE EXCEPTION 'CROSS_CASE_REFERENCE'; END IF;
 IF EXISTS (SELECT 1 FROM public."ClaimRelationship" a JOIN public."Source" b ON a."evidenceId"=b.id WHERE a."caseId"<>b."caseId" AND (a."caseId"=p_case OR b."caseId"=p_case)) THEN RAISE EXCEPTION 'CROSS_CASE_REFERENCE'; END IF;
 IF EXISTS (SELECT 1 FROM public."ReviewTrail" a JOIN public."Claim" b ON a."claimId"=b.id WHERE a."caseId"<>b."caseId" AND (a."caseId"=p_case OR b."caseId"=p_case)) THEN RAISE EXCEPTION 'CROSS_CASE_REFERENCE'; END IF;
 IF EXISTS (SELECT 1 FROM public."ReviewTrail" a JOIN public."SynthesisVersion" b ON a."synthesisId"=b.id WHERE a."caseId"<>b."caseId" AND (a."caseId"=p_case OR b."caseId"=p_case)) THEN RAISE EXCEPTION 'CROSS_CASE_REFERENCE'; END IF;
 IF EXISTS (SELECT 1 FROM public."ReviewTrail" a JOIN public."Recommendation" b ON a."recommendationId"=b.id WHERE a."caseId"<>b."caseId" AND (a."caseId"=p_case OR b."caseId"=p_case)) THEN RAISE EXCEPTION 'CROSS_CASE_REFERENCE'; END IF;
 IF EXISTS (SELECT 1 FROM public."ConsentRecord" a JOIN public."Recommendation" b ON a."recommendationId"=b.id WHERE a."caseId"<>b."caseId" AND (a."caseId"=p_case OR b."caseId"=p_case)) THEN RAISE EXCEPTION 'CROSS_CASE_REFERENCE'; END IF;
 IF EXISTS (SELECT 1 FROM public."ConsentRecord" a JOIN public."PartyOutcome" b ON a."partyOutcomeId"=b.id WHERE a."caseId"<>b."caseId" AND (a."caseId"=p_case OR b."caseId"=p_case)) THEN RAISE EXCEPTION 'CROSS_CASE_REFERENCE'; END IF;
 IF EXISTS (SELECT 1 FROM public."ContextFactor" a JOIN public."PipelineProposal" b ON a."proposalId"=b.id WHERE a."caseId"<>b."caseId" AND (a."caseId"=p_case OR b."caseId"=p_case)) THEN RAISE EXCEPTION 'CROSS_CASE_REFERENCE'; END IF;
 IF EXISTS (SELECT 1 FROM public."ContextFactor" a JOIN public."EvidenceItem" b ON a."evidenceId"=b.id WHERE a."caseId"<>b."caseId" AND (a."caseId"=p_case OR b."caseId"=p_case)) THEN RAISE EXCEPTION 'CROSS_CASE_REFERENCE'; END IF;
 IF EXISTS (SELECT 1 FROM public."PipelineProposal" a JOIN public."Claim" b ON a."acceptedClaimId"=b.id WHERE a."caseId"<>b."caseId" AND (a."caseId"=p_case OR b."caseId"=p_case)) THEN RAISE EXCEPTION 'CROSS_CASE_REFERENCE'; END IF;
 IF EXISTS (SELECT 1 FROM public."EvidenceItem" a JOIN public."EvidenceItem" b ON a."supersedesId"=b.id WHERE a."caseId"<>b."caseId" AND (a."caseId"=p_case OR b."caseId"=p_case)) THEN RAISE EXCEPTION 'CROSS_CASE_REFERENCE'; END IF;
 IF EXISTS (SELECT 1 FROM public."PartyOutcomeCitation" a JOIN public."PartyOutcome" b ON a."partyOutcomeId"=b.id JOIN public."EvidenceItem" c ON a."evidenceItemId"=c.id WHERE b."caseId"<>c."caseId" AND (b."caseId"=p_case OR c."caseId"=p_case)) THEN RAISE EXCEPTION 'CROSS_CASE_REFERENCE'; END IF;
 IF EXISTS (SELECT 1 FROM public."ClaimEvidenceLink" a JOIN public."Claim" b ON a."claimId"=b.id JOIN public."Source" c ON a."sourceId"=c.id WHERE b."caseId"<>c."caseId" AND (b."caseId"=p_case OR c."caseId"=p_case)) THEN RAISE EXCEPTION 'CROSS_CASE_REFERENCE'; END IF;
 IF EXISTS (SELECT 1 FROM public."Case" a JOIN public."Recommendation" b ON a."currentRecommendationId"=b.id WHERE a.id<>b."caseId" AND (a.id=p_case OR b."caseId"=p_case)) THEN RAISE EXCEPTION 'CROSS_CASE_REFERENCE'; END IF;
 IF EXISTS (SELECT 1 FROM public."Contestation" a JOIN public."Claim" b ON a."targetId"=b.id WHERE a."targetType"='CLAIM' AND a."caseId"<>b."caseId" AND (a."caseId"=p_case OR b."caseId"=p_case)) THEN RAISE EXCEPTION 'CROSS_CASE_REFERENCE'; END IF;
 IF EXISTS (SELECT 1 FROM public."Contestation" a JOIN public."SynthesisVersion" b ON a."targetId"=b.id WHERE a."targetType"='SYNTHESIS' AND a."caseId"<>b."caseId" AND (a."caseId"=p_case OR b."caseId"=p_case)) THEN RAISE EXCEPTION 'CROSS_CASE_REFERENCE'; END IF;
 IF EXISTS (SELECT 1 FROM public."Contestation" a JOIN public."PipelineProposal" b ON a."targetId"=b.id WHERE a."targetType"='PROPOSAL' AND a."caseId"<>b."caseId" AND (a."caseId"=p_case OR b."caseId"=p_case)) THEN RAISE EXCEPTION 'CROSS_CASE_REFERENCE'; END IF;
 IF EXISTS (SELECT 1 FROM public."Contestation" a JOIN public."Recommendation" b ON a."targetId"=b.id WHERE a."targetType"='RECOMMENDATION' AND a."caseId"<>b."caseId" AND (a."caseId"=p_case OR b."caseId"=p_case)) THEN RAISE EXCEPTION 'CROSS_CASE_REFERENCE'; END IF;
END $$;

-- Provisioning transfers this function to aequitas_erasure_owner (NOLOGIN,
-- no role members). It remains disabled before that transfer. Only a separate
-- operator login receives EXECUTE. Never grant EXECUTE to the web runtime.
CREATE FUNCTION public.purge_case_content(p_deletion text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE d public."CaseDeletion"; v_case text; expected text[];
BEGIN
 IF current_user <> 'aequitas_erasure_owner' THEN RAISE EXCEPTION 'PURGER_ROLE_NOT_PROVISIONED'; END IF;
 SELECT "caseId" INTO v_case FROM public."CaseDeletion" WHERE id=p_deletion;
 PERFORM 1 FROM public."Case" WHERE id=v_case FOR UPDATE;
 SELECT * INTO STRICT d FROM public."CaseDeletion" WHERE id=p_deletion FOR UPDATE;
 IF d."localPurgedAt" IS NOT NULL THEN RETURN; END IF;
 IF d.status<>'ERASING' OR d."holdState"<>'CLEAR' OR d."approvedAt" IS NULL
    OR d."approvalDigest" IS NULL OR d."eligibleAt">clock_timestamp() OR d."inventoryAt" IS NULL
    OR NOT EXISTS (SELECT 1 FROM public."Case" WHERE id=d."caseId" AND state='CLOSED' AND "deletionStartedAt" IS NOT NULL)
    OR EXISTS (SELECT 1 FROM public."Contestation" WHERE "caseId"=d."caseId" AND status IN ('OPEN','RESPONDED'))
    OR EXISTS (SELECT 1 FROM public."CaseOperation" WHERE "caseId"=d."caseId" AND status IN ('ACTIVE','UNCERTAIN'))
    OR EXISTS (SELECT 1 FROM public."CaseDeletionObject" WHERE "deletionId"=d.id AND "erasedAt" IS NULL)
    THEN RAISE EXCEPTION 'ERASURE_PRECONDITION_FAILED'; END IF;
 PERFORM public.retention_assert_links(d."caseId");
 expected:=ARRAY['Assumption','CaseDetailsRevision','CasePipeline','ChronologyEntry','Claim','ClaimRelationship','CoiDeclaration','ConsentRecord','Contestation','ContextFactor','Event','EvidenceItem','ExportBundle','Notification','PartyOutcome','PipelineProposal','PositionStatement','Recommendation','ReviewTrail','Source','SynthesisVersion'];
 IF (SELECT array_agg(DISTINCT cl.relname::text ORDER BY cl.relname::text)
 FROM pg_catalog.pg_constraint fk JOIN pg_catalog.pg_class cl ON cl.oid=fk.conrelid
 WHERE fk.contype='f' AND fk.confrelid='public."Case"'::regclass) IS DISTINCT FROM expected
 THEN RAISE EXCEPTION 'ERASURE_SCHEMA_INVENTORY_CHANGED'; END IF;
 DELETE FROM public."PartyOutcomeCitation" WHERE "partyOutcomeId" IN (SELECT id FROM public."PartyOutcome" WHERE "caseId"=d."caseId");
 DELETE FROM public."ClaimEvidenceLink" WHERE "claimId" IN (SELECT id FROM public."Claim" WHERE "caseId"=d."caseId");
 UPDATE public."Claim" SET "mergedIntoId"=NULL WHERE "caseId"=d."caseId";
 DELETE FROM public."ConsentRecord" WHERE "caseId"=d."caseId";
 DELETE FROM public."ReviewTrail" WHERE "caseId"=d."caseId";
 DELETE FROM public."PartyOutcome" WHERE "caseId"=d."caseId";
 DELETE FROM public."ClaimRelationship" WHERE "caseId"=d."caseId";
 DELETE FROM public."Claim" WHERE "caseId"=d."caseId";
 DELETE FROM public."Source" WHERE "caseId"=d."caseId";
 DELETE FROM public."ContextFactor" WHERE "caseId"=d."caseId";
 DELETE FROM public."PipelineProposal" WHERE "caseId"=d."caseId";
 DELETE FROM public."Assumption" WHERE "caseId"=d."caseId";
 DELETE FROM public."SynthesisVersion" WHERE "caseId"=d."caseId";
 DELETE FROM public."CasePipeline" WHERE "caseId"=d."caseId";
 DELETE FROM public."Contestation" WHERE "caseId"=d."caseId";
 DELETE FROM public."EvidenceItem" WHERE "caseId"=d."caseId";
 DELETE FROM public."PositionStatement" WHERE "caseId"=d."caseId";
 DELETE FROM public."ChronologyEntry" WHERE "caseId"=d."caseId";
 DELETE FROM public."CaseDetailsRevision" WHERE "caseId"=d."caseId";
 DELETE FROM public."Recommendation" WHERE "caseId"=d."caseId";
 DELETE FROM public."CoiDeclaration" WHERE "caseId"=d."caseId";
 DELETE FROM public."ExportBundle" WHERE "caseId"=d."caseId";
 DELETE FROM public."Notification" WHERE "caseId"=d."caseId";
 DELETE FROM public."Event" WHERE "caseId"=d."caseId";
 DELETE FROM public."Case" WHERE id=d."caseId";
 DELETE FROM public."CaseOperation" WHERE "caseId"=d."caseId";
 UPDATE public."CaseDeletion" SET status='LOCAL_PURGED', "localPurgedAt"=clock_timestamp(),
 "erasedObjectCount"=(SELECT count(*) FROM public."CaseDeletionObject" WHERE "deletionId"=d.id) WHERE id=d.id;
 DELETE FROM public."CaseDeletionObject" WHERE "deletionId"=d.id;
END $$;
REVOKE ALL ON FUNCTION public.purge_case_content(text) FROM PUBLIC;
