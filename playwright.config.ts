import { defineConfig, devices } from "@playwright/test";

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
  timeout: 30_000,
  use: {
    baseURL: "http://localhost:3000",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
