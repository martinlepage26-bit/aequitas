\set ON_ERROR_STOP on
-- Side-effect-free preflight against existing role identities, before DROP.
BEGIN READ ONLY;
SELECT set_config('aequitas.provision_runtime', :'runtime_role', true);
SELECT set_config('aequitas.provision_purger', :'purger_role', true);
DO $$
DECLARE runtime text := current_setting('aequitas.provision_runtime');
        purger text := current_setting('aequitas.provision_purger');
BEGIN
 IF runtime=purger OR runtime='aequitas_erasure_owner' OR purger='aequitas_erasure_owner' THEN RAISE EXCEPTION 'Distinct roles required'; END IF;
 IF (SELECT count(*) FROM pg_roles WHERE rolname IN (runtime,purger) AND rolcanlogin AND NOT rolsuper AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolbypassrls AND NOT rolreplication) <> 2
 THEN RAISE EXCEPTION 'Existing restricted runtime and purger logins required'; END IF;
 IF EXISTS (SELECT 1 FROM pg_auth_members WHERE member IN (SELECT oid FROM pg_roles WHERE rolname IN (runtime,purger)))
 OR EXISTS (SELECT 1 FROM pg_class WHERE relnamespace='public'::regnamespace AND relowner IN (SELECT oid FROM pg_roles WHERE rolname IN (runtime,purger)))
 OR EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proowner IN (SELECT oid FROM pg_roles WHERE rolname IN (runtime,purger)))
 OR EXISTS (SELECT 1 FROM pg_namespace WHERE nspname='public' AND nspowner IN (SELECT oid FROM pg_roles WHERE rolname IN (runtime,purger)))
 OR EXISTS (SELECT 1 FROM pg_database WHERE datname=current_database() AND datdba IN (SELECT oid FROM pg_roles WHERE rolname IN (runtime,purger)))
 THEN RAISE EXCEPTION 'Runtime and purger must not own objects or have memberships'; END IF;
END $$;
ROLLBACK;
