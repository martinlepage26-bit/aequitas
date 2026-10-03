import "./src/lib/loadEnv";
import { defineConfig, devices } from "@playwright/test";
import { applyTestDatabase } from "./test/testDatabaseUrl";
import { resolve } from "node:path";

// Do not reuse a developer's port 3000 server: the fixtures and application
// must use the same isolated test database. Build a separate snapshot first.
applyTestDatabase();
const buildDir = process.env.AEQUITAS_SUBMISSION_BUILD_DIR;
if (!buildDir) throw new Error("Set AEQUITAS_SUBMISSION_BUILD_DIR to a verified isolated Next production build.");
export default defineConfig({
  testDir: "./e2e", testMatch: "submissions.spec.ts", fullyParallel: false, workers: 1, timeout: 60000,
  reporter: "list", use: { baseURL: "http://localhost:3432", trace: "retain-on-failure" },
  webServer: {
    command: `node ${JSON.stringify(resolve("node_modules/next/dist/bin/next"))} start -H 127.0.0.1 -p 3432`,
    cwd: buildDir, url: "http://localhost:3432", reuseExistingServer: false, timeout: 60000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], launchOptions: {
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}),
    args: ["--no-sandbox"],
  } } }],
});
