import { describe, expect, it } from "vitest";
import { runtimeRoleAllowed } from "../../deploy/ct920/verify-runtime-role.mjs";

const restricted = {
  superuser: false, create_role: false, create_database: false, bypass_rls: false, replication: false,
  owns_database: false, owns_objects: false, owns_functions: false, owns_schema: false,
  role_memberships: false, schema_create: false, purge_execute: false,
  purge_owner: "aequitas_erasure_owner", purge_owner_login: false, purge_owner_members: false,
};

describe("runtime database role deployment gate", () => {
  it("accepts the restricted runtime role with an isolated non-login purge owner", () => {
    expect(runtimeRoleAllowed(restricted, true)).toBe(true);
  });
  it.each(["superuser", "create_role", "create_database", "bypass_rls", "replication", "owns_database", "owns_objects", "owns_functions", "owns_schema", "role_memberships", "schema_create", "purge_execute"])("refuses %s even with retention disabled", key => {
    expect(runtimeRoleAllowed({ ...restricted, [key]: true }, false)).toBe(false);
  });
  it.each([
    { purge_owner: "aequitas" }, { purge_owner_login: true }, { purge_owner_members: true }, { purge_owner: null },
  ])("requires isolated purge ownership when retention is enabled: %j", change => {
    expect(runtimeRoleAllowed({ ...restricted, ...change }, true)).toBe(false);
  });
  it("fails closed on incomplete database evidence", () => {
    expect(runtimeRoleAllowed(null, false)).toBe(false);
    expect(runtimeRoleAllowed({}, false)).toBe(false);
  });
});
