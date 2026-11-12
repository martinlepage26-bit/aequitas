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
      SELECT "caseId" INTO c FROM public."EvidenceItem" WHERE id=v->>'evidenceId';
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
