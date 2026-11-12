import pg from "pg";
import { pathToFileURL } from "node:url";

/** Pure predicate exported for refusal-path tests; never returns credentials. */
export function runtimeRoleAllowed(row, retentionEnabled) {
  if (!row || ["superuser", "create_role", "create_database", "bypass_rls", "replication", "owns_database", "owns_objects", "owns_functions", "owns_schema", "role_memberships", "schema_create", "purge_execute"].some(key => row[key] !== false)) return false;
  return !retentionEnabled || (row.purge_owner === "aequitas_erasure_owner" && row.purge_owner_login === false && row.purge_owner_members === false);
}

export async function verifyRuntimeRole() {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5_000, query_timeout: 15_000 });
  try {
    await client.connect();
    await client.query("BEGIN READ ONLY");
    const { rows } = await client.query(`
      SELECT r.rolsuper AS superuser, r.rolcreaterole AS create_role, r.rolcreatedb AS create_database,
        r.rolbypassrls AS bypass_rls, r.rolreplication AS replication, d.datdba=r.oid AS owns_database,
        EXISTS (SELECT 1 FROM pg_class WHERE relnamespace='public'::regnamespace AND relowner=r.oid) AS owns_objects,
        EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proowner=r.oid) AS owns_functions,
        EXISTS (SELECT 1 FROM pg_namespace WHERE nspname='public' AND nspowner=r.oid) AS owns_schema,
        EXISTS (SELECT 1 FROM pg_auth_members WHERE member=r.oid) AS role_memberships,
        has_schema_privilege(current_user,'public','CREATE') AS schema_create,
        CASE WHEN to_regprocedure('public.purge_case_content(text)') IS NULL THEN false
          ELSE has_function_privilege(current_user,'public.purge_case_content(text)','EXECUTE') END AS purge_execute,
        (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid=to_regprocedure('public.purge_case_content(text)')) AS purge_owner,
        (SELECT rolcanlogin FROM pg_roles WHERE rolname='aequitas_erasure_owner') AS purge_owner_login,
        EXISTS (SELECT 1 FROM pg_auth_members WHERE roleid=(SELECT oid FROM pg_roles WHERE rolname='aequitas_erasure_owner')) AS purge_owner_members
      FROM pg_roles r JOIN pg_database d ON d.datname=current_database() WHERE r.rolname=current_user`);
    if (!runtimeRoleAllowed(rows[0], process.env.RETENTION_ENFORCEMENT_ENABLED === "true")) throw new Error("RUNTIME_DATABASE_ROLE_UNSAFE");
    await client.query("ROLLBACK");
    console.log("Runtime database role isolation verified.");
  } finally { await client.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyRuntimeRole().catch(() => { console.error("RUNTIME_DATABASE_ROLE_VERIFICATION_FAILED"); process.exitCode = 1; });
}
