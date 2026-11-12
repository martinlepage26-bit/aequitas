-- An independently replayed tombstone blocks creation even when the backup
-- predates the original Case. Existing frozen cases remain inaccessible.
CREATE OR REPLACE FUNCTION public.retention_check_case(p_case text) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  PERFORM 1 FROM public."Case" WHERE id = p_case FOR UPDATE;
  IF EXISTS (SELECT 1 FROM public."Case" WHERE id=p_case AND "deletionStartedAt" IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public."CaseDeletion" WHERE "caseId"=p_case AND "frozenAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'CASE_DELETION_FROZEN';
  END IF;
END $$;
