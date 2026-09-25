/**
 * Tests never touch the dev database. The suite (vitest, and the `next dev`
 * servers it spawns, and Playwright) runs against a separate `aequitas_test`
 * database on the same Postgres: TEST_DATABASE_URL when set, otherwise
 * DATABASE_URL with its database name swapped for `aequitas_test`.
 *
 * Refuses any URL whose database name does not end in `_test`, so a
 * misconfigured environment fails loudly instead of writing test rows (or
 * running the tamper test) against dev, demo or production data.
 */
export function testDatabaseUrl(): string {
  const explicit = process.env.TEST_DATABASE_URL;
  let url: URL;
  if (explicit) {
    url = new URL(explicit);
  } else {
    const base = process.env.DATABASE_URL;
    if (!base) throw new Error("Neither TEST_DATABASE_URL nor DATABASE_URL is set; cannot locate the test database.");
    url = new URL(base);
    url.pathname = "/aequitas_test";
  }
  const dbName = url.pathname.replace(/^\//, "");
  if (!dbName.endsWith("_test")) {
    throw new Error(`Refusing to run tests against database "${dbName}": the test database name must end in "_test".`);
  }
  return url.toString();
}

/** Point this process (and every child it spawns) at the test database. */
export function applyTestDatabase(): void {
  process.env.DATABASE_URL = testDatabaseUrl();
}
