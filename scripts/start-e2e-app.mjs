import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const requestedPort = process.argv.indexOf("--port");
const port = requestedPort >= 0 ? process.argv[requestedPort + 1] : "3000";
const dev = process.argv.includes("--dev") || process.env.CI !== "true";
const parserDirectory = await mkdtemp(join(tmpdir(), "aequitas-e2e-parser-"));
const socketPath = join(parserDirectory, "evidence.sock");
const parserEnv = {
  PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
  HOME: parserDirectory,
  TMPDIR: parserDirectory,
  LANG: "C",
  LC_ALL: "C",
  OMP_THREAD_LIMIT: "1",
  NODE_ENV: "production",
  AEQUITAS_EVIDENCE_PARSER_SOCKET: socketPath,
  AEQUITAS_OCR_LANGUAGES: process.env.AEQUITAS_OCR_LANGUAGES ?? "eng+fra",
};
if (process.platform === "darwin") {
  for (const [environmentName, binary] of Object.entries({
    AEQUITAS_PDFINFO_PATH: "pdfinfo",
    AEQUITAS_PDFTOTEXT_PATH: "pdftotext",
    AEQUITAS_PDFIMAGES_PATH: "pdfimages",
    AEQUITAS_PDFTOPPM_PATH: "pdftoppm",
    AEQUITAS_TESSERACT_PATH: "tesseract",
  })) {
    const executable = `/opt/homebrew/bin/${binary}`;
    if (existsSync(executable)) parserEnv[environmentName] = executable;
  }
}
const appEnv = { ...process.env, AEQUITAS_EVIDENCE_PARSER_SOCKET: socketPath };
for (const key of [
  "GEMINI_API_KEY",
  "GOOGLE_AI_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "AEQUITAS_VERTEX_PROJECT_ID",
  "STORAGE_ENDPOINT",
  "STORAGE_ACCESS_KEY",
  "STORAGE_SECRET_KEY",
  "STORAGE_BUCKET",
  "STORAGE_REGION",
]) appEnv[key] = "";

let parser;
let app;
let stopping = false;

function waitForParser(child) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const check = () => {
      if (child.exitCode !== null) {
        reject(new Error("Evidence parser exited before becoming ready."));
        return;
      }
      const req = request({ socketPath, path: "/health", method: "GET", agent: false }, (res) => {
        res.resume();
        res.on("end", () => {
          if (res.statusCode === 200) resolve();
          else retry();
        });
      });
      req.setTimeout(500, () => req.destroy());
      req.once("error", retry);
      req.end();
    };
    const retry = () => {
      attempts += 1;
      if (attempts >= 50) reject(new Error("Evidence parser did not become ready."));
      else setTimeout(check, 100);
    };
    check();
  });
}

function stop() {
  if (stopping) return;
  stopping = true;
  app?.kill("SIGTERM");
  parser?.kill("SIGTERM");
}

process.once("SIGTERM", stop);
process.once("SIGINT", stop);

try {
  parser = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/evidence-parser-entry.ts"], {
    cwd: process.cwd(),
    env: parserEnv,
    stdio: "inherit",
  });
  await waitForParser(parser);
  app = spawn(process.execPath, [
    "node_modules/next/dist/bin/next",
    dev ? "dev" : "start",
    "--port",
    String(port),
    "--hostname",
    "127.0.0.1",
  ], { cwd: process.cwd(), env: appEnv, stdio: "inherit" });
  const exitCode = await new Promise((resolve, reject) => {
    app.once("error", reject);
    app.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
  stop();
  if (parser.exitCode === null) await new Promise((resolve) => parser.once("exit", resolve));
  process.exitCode = Number(exitCode);
} catch (error) {
  stop();
  if (parser && parser.exitCode === null) await new Promise((resolve) => parser.once("exit", resolve));
  process.stderr.write(`${error instanceof Error ? error.message : "Test server startup failed."}\n`);
  process.exitCode = 1;
} finally {
  await rm(parserDirectory, { recursive: true, force: true });
}
