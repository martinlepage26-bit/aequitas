import "./src/lib/loadEnv";
import { defineConfig, devices } from "@playwright/test";
import { applyTestDatabase } from "./test/testDatabaseUrl";

applyTestDatabase();
process.env.RESEND_API_KEY = "";
process.env.AEQUITAS_PIPELINE_ENABLED = "true";
const testPort = Number(process.env.PHASE2_PORT ?? 3010);
process.env.PLAYWRIGHT_PORT = String(testPort);
process.env.WEBAUTHN_RP_ID = "localhost";
process.env.WEBAUTHN_ORIGIN = `http://localhost:${testPort}`;

export default defineConfig({
  testDir: "./e2e",
  testMatch: /phase2-pipeline\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  timeout: 90_000,
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
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
