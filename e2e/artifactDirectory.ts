import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

/** Keep browser screenshots inside the test workspace unless an output directory is supplied. */
export function e2eArtifactDirectory(): string {
  const configured = process.env.AEQUITAS_E2E_ARTIFACTS_DIR?.trim();
  const directory = configured
    ? resolve(configured)
    : join(process.cwd(), "test-results", "artifacts");
  mkdirSync(directory, { recursive: true });
  return directory;
}
