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
 * uses. Locally, `reuseExistingServer` reuses a developer's already-running
 * dev server (Next.js 16 allows only one `next dev` per directory; see
 * DECISIONS.md, M2). CI has no server yet and `npm run build` has already
 * run, so it serves that production build with `next start`. `next dev`
 * compiles each route on first request, and that work used to fall inside
 * the assertion that hit the route first. The sign-in form still hydrates
 * after the URL commits, on either server; the auth spec waits for the
 * hydrated field before clicking Continue.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  // WebAuthn ceremonies and case navigation need more than Playwright's 5s
  // expect default. This does not paper over a missing page: the assertion
  // still requires the expected URL or element.
  timeout: 60_000,
  expect: { timeout: 20_000 },
  use: {
    baseURL: `http://localhost:${testPort}`,
    trace: "retain-on-failure",
  },
  webServer: {
    command: process.env.CI
      ? `node node_modules/next/dist/bin/next start --port ${testPort}`
      : `node node_modules/next/dist/bin/next dev --port ${testPort}`,
    url: `http://localhost:${testPort}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
