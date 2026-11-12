import { defineConfig } from "vitest/config";
import base from "./vitest.config.mts";
export default defineConfig({ ...base, test: {
  ...base.test,
  include: ["test/integration/retention-lifecycle.test.ts"],
  exclude: ["**/node_modules/**"],
} });
