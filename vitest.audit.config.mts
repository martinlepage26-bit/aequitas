import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * Black-box backend audit suites (test/audit/**). They talk HTTP to an already-running production-mode
 * server and inspect a disposable database/object store, so they are NOT part of the default `npm test`.
 * Run through audit/backend-e2e-20261003/harness/run-suite.sh, which prepares and verifies the environment.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/audit/**/*.audit.ts"],
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 180_000,
    reporters: ["verbose", ["json", { outputFile: process.env.AUDIT_RESULTS_JSON ?? "audit/backend-e2e-20261003/evidence/results/vitest-audit.json" }]],
  },
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "./src") } },
});
