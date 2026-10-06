import "./src/lib/loadEnv";
import { defineConfig, devices } from "@playwright/test";
import { applyTestDatabase } from "./test/testDatabaseUrl";

// Same rule as the vitest suite (test/setup.ts): E2E specs and the `next dev`
// they start write to the separate aequitas_test database, never dev.
// Workers and the webServer inherit this process's environment.
applyTestDatabase();
process.env.RESEND_API_KEY = "";
const testPort = Number(process.env.PLAYWRIGHT_PORT ?? 3000);
// Virtual browser credentials must be checked against the actual test
// server, independently of a developer's demo or production RP settings.
process.env.WEBAUTHN_RP_ID = "localhost";
process.env.WEBAUTHN_ORIGIN = `http://localhost:${testPort}`;

/**
 * M2's "Done when" criterion (Section 19): "M2 E2E segment passes in both
 * locales." baseURL/webServer point at the same port `npm run dev` normally
 * uses — `reuseExistingServer` (Playwright's own recommended pattern) means
 * a developer's already-running dev server is reused locally with zero
 * setup, while CI (no server running yet) gets one started fresh. This
 * sidesteps Next.js 16's "only one next dev per project directory" rule
 * (see DECISIONS.md, M2) rather than fighting it with a second port.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  // A cold CI checkout has no warm .next/dev cache, so the first request to
  // a route pays for on-demand compilation inside whatever assertion is
  // waiting on it. `timeout` does not extend Playwright's expect timeout.
  // The default 5s expired on push while that compile was still in flight:
  // run 37464352382 (/api/auth/webauthn/register) and run 37469978362
  // (fr-CA submissions, /api/cases/[caseId]/chronology, element still
  // absent at 5s). The same SHAs passed on pull_request, and the other
  // locale passed once the route was compiled. 20s still requires the
  // expected UI. A warm local .next/dev cache does not pay this cost, which
  // is why a local run does not reproduce it.
  timeout: 60_000,
  expect: { timeout: 20_000 },
  use: {
    baseURL: `http://localhost:${testPort}`,
    trace: "retain-on-failure",
  },
  webServer: {
    command: `node node_modules/next/dist/bin/next dev --port ${testPort}`,
    url: `http://localhost:${testPort}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
