\set ON_ERROR_STOP on
-- Run by the database owner, with explicit existing login role names:
-- psql ... -v runtime_role=aequitas_web -v purger_role=aequitas_purger -f this-file
-- Do not use the web login for migrations or database ownership.
BEGIN;
SELECT set_config('aequitas.provision_runtime', :'runtime_role', true);
SELECT set_config('aequitas.provision_purger', :'purger_role', true);
DO $$
DECLARE runtime text := current_setting('aequitas.provision_runtime');
        purger text := current_setting('aequitas.provision_purger');
BEGIN
 IF runtime=purger OR runtime='aequitas_erasure_owner' OR purger='aequitas_erasure_owner' THEN RAISE EXCEPTION 'Distinct roles required'; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=runtime AND rolcanlogin AND NOT rolsuper AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolbypassrls AND NOT rolreplication)
 OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=purger AND rolcanlogin AND NOT rolsuper AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolbypassrls AND NOT rolreplication)
 THEN RAISE EXCEPTION 'Pre-provision restricted runtime and purger logins'; END IF;
 IF EXISTS (SELECT 1 FROM pg_class WHERE relnamespace='public'::regnamespace AND relowner IN (SELECT oid FROM pg_roles WHERE rolname IN (runtime,purger)))
 OR EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proowner IN (SELECT oid FROM pg_roles WHERE rolname IN (runtime,purger)))
 OR EXISTS (SELECT 1 FROM pg_namespace WHERE nspname='public' AND nspowner IN (SELECT oid FROM pg_roles WHERE rolname IN (runtime,purger)))
 OR EXISTS (SELECT 1 FROM pg_database WHERE datname=current_database() AND datdba IN (SELECT oid FROM pg_roles WHERE rolname IN (runtime,purger)))
 THEN RAISE EXCEPTION 'Runtime and purger must not own database objects'; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='aequitas_erasure_owner') THEN CREATE ROLE aequitas_erasure_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION; END IF;
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='aequitas_erasure_owner' AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls OR rolreplication))
 OR EXISTS (SELECT 1 FROM pg_auth_members WHERE roleid=(SELECT oid FROM pg_roles WHERE rolname='aequitas_erasure_owner'))
 THEN RAISE EXCEPTION 'Erasure owner must be restricted NOLOGIN with no members'; END IF;
 -- Even inherited membership in a migration owner or the purger would break
 -- the separation. Keep both logins free of role memberships.
 IF EXISTS (SELECT 1 FROM pg_auth_members WHERE member IN (SELECT oid FROM pg_roles WHERE rolname IN (runtime,purger))) THEN RAISE EXCEPTION 'Runtime/purger memberships must be reviewed and removed'; END IF;
END $$;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO aequitas_erasure_owner;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO aequitas_erasure_owner;
GRANT DELETE ON "Case", "EvidenceItem", "PositionStatement", "ChronologyEntry", "Recommendation", "PartyOutcome", "PartyOutcomeCitation", "ConsentRecord", "CoiDeclaration", "CaseDetailsRevision", "Event", "ExportBundle", "Notification", "Source", "Claim", "ClaimEvidenceLink", "ClaimRelationship", "ReviewTrail", "Assumption", "CasePipeline", "PipelineProposal", "ContextFactor", "SynthesisVersion", "Contestation", "CaseOperation", "CaseDeletionObject" TO aequitas_erasure_owner;
GRANT UPDATE ON "Case", "Claim", "CaseDeletion" TO aequitas_erasure_owner;
ALTER FUNCTION public.purge_case_content(text) OWNER TO aequitas_erasure_owner;
REVOKE ALL ON FUNCTION public.purge_case_content(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.purge_case_content(text) FROM :"runtime_role";
GRANT USAGE ON SCHEMA public TO :"purger_role";
GRANT EXECUTE ON FUNCTION public.purge_case_content(text) TO :"purger_role";
-- The purger gets no direct table writes or access to shared account records.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM :"purger_role";
COMMIT;
