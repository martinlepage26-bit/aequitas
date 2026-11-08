import "../src/lib/loadEnv";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll } from "vitest";
import { applyTestDatabase } from "./testDatabaseUrl";
import { startEvidenceParserService } from "../scripts/evidence-parser-service";

// Runs before each test file is imported, so src/lib/prisma (which reads
// DATABASE_URL at import time) and any `next dev` a suite spawns (which
// inherits this process's env, and Next never overrides an already-set
// variable from .env.local) both see the test database, never dev.
applyTestDatabase();
// Test fixtures must never deliver email, even if a developer configured a real provider.
process.env.RESEND_API_KEY = "";

// Apple Silicon Homebrew lives outside the parser's fixed safe PATH. Point
// the test-only local service at those exact binaries without widening the
// child-process environment used by production extraction.
if (process.platform === "darwin") {
  const homebrewTools = {
    AEQUITAS_PDFINFO_PATH: "pdfinfo",
    AEQUITAS_PDFTOTEXT_PATH: "pdftotext",
    AEQUITAS_PDFIMAGES_PATH: "pdfimages",
    AEQUITAS_PDFTOPPM_PATH: "pdftoppm",
    AEQUITAS_TESSERACT_PATH: "tesseract",
  } as const;
  for (const [environmentName, binary] of Object.entries(homebrewTools)) {
    const executable = `/opt/homebrew/bin/${binary}`;
    if (existsSync(executable)) process.env[environmentName] = executable;
  }
}

const parserDirectory = mkdtempSync(join(tmpdir(), "aequitas-vitest-parser-"));
const parserSocket = join(parserDirectory, "evidence.sock");
process.env.AEQUITAS_EVIDENCE_PARSER_SOCKET = parserSocket;
let parserServer: Awaited<ReturnType<typeof startEvidenceParserService>> | undefined;

beforeAll(async () => {
  parserServer = await startEvidenceParserService(parserSocket);
});

afterAll(async () => {
  if (parserServer) {
    await new Promise<void>((resolve, reject) => {
      parserServer!.close((error) => error ? reject(error) : resolve());
    });
  }
  rmSync(parserDirectory, { recursive: true, force: true });
});
