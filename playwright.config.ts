import "./src/lib/loadEnv";
import { defineConfig, devices } from "@playwright/test";
import { applyTestDatabase } from "./test/testDatabaseUrl";

// Same rule as the vitest suite (test/setup.ts): E2E specs and the `next dev`
// they start write to the separate aequitas_test database, never dev.
// Workers and the webServer inherit this process's environment.
applyTestDatabase();
process.env.RESEND_API_KEY = "";
const testPort = Number(process.env.PLAYWRIGHT_PORT ?? 3000);

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
  // A genuinely cold CI checkout has no warm .next/dev cache, so the FIRST
  // test pays for next dev's on-demand per-route compilation across every
  // route it's the first to hit (case-lifecycle.spec.ts, fr-CA, run first)
  // — confirmed live in CI: that run alone exceeded a 30s timeout while the
  // second (en-CA, routes already compiled) finished in 23.2s. Not a real
  // bug; a local sandbox with prior `next dev`/`next build` runs never
  // reproduces this because its .next/dev cache is already warm.
  timeout: 60_000,
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
