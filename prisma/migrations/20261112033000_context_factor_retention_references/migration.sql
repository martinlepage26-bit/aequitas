-- ContextFactor evidenceId points to a Source or Claim, never an EvidenceItem.
CREATE OR REPLACE FUNCTION public.retention_assert_links(p_case text) RETURNS void
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
 IF EXISTS (SELECT 1 FROM public."ContextFactor" a JOIN public."Source" b ON a."evidenceId"=b.id WHERE a."caseId"<>b."caseId" AND (a."caseId"=p_case OR b."caseId"=p_case)) THEN RAISE EXCEPTION 'CROSS_CASE_REFERENCE'; END IF;
 IF EXISTS (SELECT 1 FROM public."ContextFactor" a JOIN public."Claim" b ON a."evidenceId"=b.id WHERE a."caseId"<>b."caseId" AND (a."caseId"=p_case OR b."caseId"=p_case)) THEN RAISE EXCEPTION 'CROSS_CASE_REFERENCE'; END IF;
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

CREATE OR REPLACE FUNCTION public.retention_write_barrier() RETURNS trigger
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
    -- Referencing a frozen case from an unfrozen case is also forbidden.
    IF TG_TABLE_NAME='Case' AND v->>'currentRecommendationId' IS NOT NULL THEN
      SELECT "caseId" INTO c FROM public."Recommendation" WHERE id=v->>'currentRecommendationId';
      PERFORM public.retention_check_case(c);
    END IF;
    IF TG_TABLE_NAME='Source' AND v->>'evidenceItemId' IS NOT NULL THEN
      SELECT "caseId" INTO c FROM public."EvidenceItem" WHERE id=v->>'evidenceItemId';
      PERFORM public.retention_check_case(c);
    END IF;
    IF TG_TABLE_NAME='Claim' AND v->>'mergedIntoId' IS NOT NULL THEN
      SELECT "caseId" INTO c FROM public."Claim" WHERE id=v->>'mergedIntoId';
      PERFORM public.retention_check_case(c);
    END IF;
    IF TG_TABLE_NAME='ClaimRelationship' AND v->>'fromClaimId' IS NOT NULL THEN
      SELECT "caseId" INTO c FROM public."Claim" WHERE id=v->>'fromClaimId';
      PERFORM public.retention_check_case(c);
    END IF;
    IF TG_TABLE_NAME='ClaimRelationship' AND v->>'toClaimId' IS NOT NULL THEN
      SELECT "caseId" INTO c FROM public."Claim" WHERE id=v->>'toClaimId';
      PERFORM public.retention_check_case(c);
    END IF;
    IF TG_TABLE_NAME='ClaimRelationship' AND v->>'evidenceId' IS NOT NULL THEN
      SELECT "caseId" INTO c FROM public."Source" WHERE id=v->>'evidenceId';
      PERFORM public.retention_check_case(c);
    END IF;
    IF TG_TABLE_NAME='ReviewTrail' AND v->>'claimId' IS NOT NULL THEN
      SELECT "caseId" INTO c FROM public."Claim" WHERE id=v->>'claimId';
      PERFORM public.retention_check_case(c);
    END IF;
    IF TG_TABLE_NAME='ReviewTrail' AND v->>'synthesisId' IS NOT NULL THEN
      SELECT "caseId" INTO c FROM public."SynthesisVersion" WHERE id=v->>'synthesisId';
      PERFORM public.retention_check_case(c);
    END IF;
    IF TG_TABLE_NAME='ReviewTrail' AND v->>'recommendationId' IS NOT NULL THEN
      SELECT "caseId" INTO c FROM public."Recommendation" WHERE id=v->>'recommendationId';
      PERFORM public.retention_check_case(c);
    END IF;
    IF TG_TABLE_NAME='ConsentRecord' AND v->>'recommendationId' IS NOT NULL THEN
      SELECT "caseId" INTO c FROM public."Recommendation" WHERE id=v->>'recommendationId';
      PERFORM public.retention_check_case(c);
    END IF;
    IF TG_TABLE_NAME='ConsentRecord' AND v->>'partyOutcomeId' IS NOT NULL THEN
      SELECT "caseId" INTO c FROM public."PartyOutcome" WHERE id=v->>'partyOutcomeId';
      PERFORM public.retention_check_case(c);
    END IF;
    IF TG_TABLE_NAME='ContextFactor' AND v->>'proposalId' IS NOT NULL THEN
      SELECT "caseId" INTO c FROM public."PipelineProposal" WHERE id=v->>'proposalId';
      PERFORM public.retention_check_case(c);
    END IF;
    IF TG_TABLE_NAME='ContextFactor' AND v->>'evidenceId' IS NOT NULL THEN
      SELECT "caseId" INTO c FROM public."Source" WHERE id=v->>'evidenceId';
      PERFORM public.retention_check_case(c);
    END IF;
    IF TG_TABLE_NAME='ContextFactor' AND v->>'evidenceId' IS NOT NULL THEN
      SELECT "caseId" INTO c FROM public."Claim" WHERE id=v->>'evidenceId';
      PERFORM public.retention_check_case(c);
    END IF;
    IF TG_TABLE_NAME='PipelineProposal' AND v->>'acceptedClaimId' IS NOT NULL THEN
      SELECT "caseId" INTO c FROM public."Claim" WHERE id=v->>'acceptedClaimId';
      PERFORM public.retention_check_case(c);
    END IF;
    IF TG_TABLE_NAME='EvidenceItem' AND v->>'supersedesId' IS NOT NULL THEN
      SELECT "caseId" INTO c FROM public."EvidenceItem" WHERE id=v->>'supersedesId';
      PERFORM public.retention_check_case(c);
    END IF;
    IF TG_TABLE_NAME='Contestation' AND v->>'targetType'='CLAIM' THEN
      SELECT "caseId" INTO c FROM public."Claim" WHERE id=v->>'targetId';
      PERFORM public.retention_check_case(c);
    END IF;
    IF TG_TABLE_NAME='Contestation' AND v->>'targetType'='SYNTHESIS' THEN
      SELECT "caseId" INTO c FROM public."SynthesisVersion" WHERE id=v->>'targetId';
      PERFORM public.retention_check_case(c);
    END IF;
    IF TG_TABLE_NAME='Contestation' AND v->>'targetType'='PROPOSAL' THEN
      SELECT "caseId" INTO c FROM public."PipelineProposal" WHERE id=v->>'targetId';
      PERFORM public.retention_check_case(c);
    END IF;
    IF TG_TABLE_NAME='Contestation' AND v->>'targetType'='RECOMMENDATION' THEN
      SELECT "caseId" INTO c FROM public."Recommendation" WHERE id=v->>'targetId';
      PERFORM public.retention_check_case(c);
    END IF;
  END LOOP;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
