import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    // Test files share one Postgres database, and the HTTP suites each spawn
    // a `next dev` (Next 16 allows only one per project directory). Running
    // files one at a time removes both classes of cross-file interference;
    // tests inside a file still run in order as before.
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
});
