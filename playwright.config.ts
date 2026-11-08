import "./src/lib/loadEnv";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { applyTestDatabase } from "./test/testDatabaseUrl";

// Same rule as the vitest suite (test/setup.ts): E2E specs and the `next dev`
// they start write to the separate aequitas_test database, never dev.
// Workers and the webServer inherit this process's environment.
applyTestDatabase();
process.env.RESEND_API_KEY = "";
process.env.SESSION_SECRET = "aequitas-playwright-test-only-session-secret";
// The browser suite renders and submits party processing choices against a
// synthetic provider identity. No provider credential is set in E2E.
process.env.AEQUITAS_CASE_AGENT_ENABLED = "true";
process.env.AEQUITAS_CASE_AGENT_MAX_AMOUNT_CENTS = "500000";
process.env.AEQUITAS_CASE_AGENT_MAX_MODEL_CALLS_PER_UTC_DAY = "1000";
process.env.AEQUITAS_CASE_AGENT_INTAKE_DAYS = "7";
process.env.AEQUITAS_CASE_AGENT_RESPONSE_DAYS = "5";
process.env.AEQUITAS_CASE_AGENT_RESPONDENT_MAY_WITHDRAW = "true";
process.env.AEQUITAS_CASE_AGENT_CONSENT_ONLY_RESOLUTION = "true";
process.env.AEQUITAS_PIPELINE_PROVIDER = "gemini";
process.env.GEMINI_PROJECT_ID = "synthetic-e2e-project";
process.env.GEMINI_MODEL = "gemini-3.8-flash";
process.env.AEQUITAS_CASE_AGENT_PROCESSING_NOTICE_EN = "Synthetic E2E notice: case content would be sent to the configured model provider.";
process.env.AEQUITAS_CASE_AGENT_PROCESSING_NOTICE_FR = "Avis E2E synthétique : le contenu du dossier serait transmis au fournisseur de modèle configuré.";
if (!process.env.AEQUITAS_E2E_STORAGE_OWNER_PID) {
  const e2eStorageDir = mkdtempSync(join(tmpdir(), "aequitas-playwright-storage-"));
  process.env.STORAGE_LOCAL_DIR = e2eStorageDir;
  process.env.AEQUITAS_E2E_STORAGE_OWNER_PID = String(process.pid);
  process.on("exit", () => rmSync(e2eStorageDir, { recursive: true, force: true }));
}

// On a developer machine with no ClamAV sidecar, run the E2E suite against a
// tiny test-only INSTREAM responder. CI keeps its real ClamAV service, and a
// local operator with ClamAV can opt out with AEQUITAS_E2E_REAL_CLAMAV=true.
if (!process.env.CI && process.env.AEQUITAS_E2E_REAL_CLAMAV !== "true" && !process.env.AEQUITAS_E2E_SCANNER_OWNER_PID) {
  const scannerPort = Number(process.env.AEQUITAS_E2E_CLAMAV_PORT ?? "43110");
  const scanner = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let commandRead = false;
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!commandRead) {
        const newline = buffer.indexOf(0x0a);
        if (newline < 0) return;
        if (buffer.subarray(0, newline).toString("ascii") !== "nINSTREAM") {
          socket.end("UNKNOWN COMMAND\n");
          return;
        }
        buffer = buffer.subarray(newline + 1);
        commandRead = true;
      }
      while (buffer.byteLength >= 4) {
        const size = buffer.readUInt32BE(0);
        if (buffer.byteLength < size + 4) return;
        buffer = buffer.subarray(size + 4);
        if (size === 0) {
          socket.end("stream: OK\n");
          return;
        }
      }
    });
  });
  scanner.on("error", (error) => { throw error; });
  scanner.listen(scannerPort, "127.0.0.1");
  scanner.unref();
  process.env.CLAMAV_HOST = "127.0.0.1";
  process.env.CLAMAV_PORT = String(scannerPort);
  process.env.AEQUITAS_E2E_SCANNER_OWNER_PID = String(process.pid);
}
const testPort = Number(process.env.PLAYWRIGHT_PORT ?? 3000);
// Virtual browser credentials must be checked against the actual test
// server, independently of a developer's demo or production RP settings.
process.env.WEBAUTHN_RP_ID = "localhost";
process.env.WEBAUTHN_ORIGIN = `http://localhost:${testPort}`;

/**
 * M2's "Done when" criterion (Section 19): "M2 E2E segment passes in both
 * locales." baseURL/webServer point at the same port `npm run dev` normally
 * uses. The wrapper starts a test-only parser with a credential-free
 * environment, then runs `next dev` locally or the production build with
 * `next start` in CI. Existing servers are not reused because they may not
 * have the parser socket. `next dev` compiles each route on first request,
 * and that work used to fall inside
 * the assertion that hit the route first. The sign-in form still hydrates
 * after the URL commits, on either server; the auth spec waits for the
 * hydrated field before clicking Continue.
 */
export default defineConfig({
  testDir: "./e2e",
  testIgnore: /phase2-pipeline\.spec\.ts/,
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
    command: `node scripts/start-e2e-app.mjs --port ${testPort}`,
    url: `http://localhost:${testPort}`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
