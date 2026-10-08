import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { launcherExitCode } from "../../scripts/start.mjs";

const launcher = path.resolve(import.meta.dirname, "../../scripts/start.mjs");

/** Stand-in for `next start` that behaves like Next 16: exit 143 after SIGTERM. */
function fakeNext(onTerm: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "aequitas-start-"));
  const file = path.join(dir, "next.cjs");
  writeFileSync(file, `process.on("SIGTERM", () => { ${onTerm} }); console.log("ready"); setInterval(() => {}, 1000);\n`);
  return file;
}

function runAndStop(bin: string): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [launcher], { env: { ...process.env, AEQUITAS_NEXT_BIN: bin }, stdio: ["ignore", "pipe", "inherit"] });
    proc.stdout.on("data", (chunk: Buffer) => { if (chunk.toString().includes("ready")) proc.kill("SIGTERM"); });
    proc.on("error", reject);
    proc.on("exit", (code, signal) => resolve({ code, signal }));
  });
}

describe("production start launcher", () => {
  it("treats a requested stop as a clean exit", () => {
    expect(launcherExitCode("SIGTERM", 143, null)).toBe(0);
    expect(launcherExitCode("SIGTERM", null, "SIGTERM")).toBe(0);
    expect(launcherExitCode("SIGINT", 130, null)).toBe(0);
    expect(launcherExitCode("SIGTERM", 0, null)).toBe(0);
  });
  it("keeps real failures visible", () => {
    expect(launcherExitCode(null, 1, null)).toBe(1);
    expect(launcherExitCode(null, 143, null)).toBe(143);
    expect(launcherExitCode("SIGTERM", 1, null)).toBe(1);
    expect(launcherExitCode(null, null, "SIGKILL")).toBe(1);
  });
  it("exits 0 when Railway stops a running server with SIGTERM", async () => {
    expect(await runAndStop(fakeNext("process.exit(143);"))).toEqual({ code: 0, signal: null });
  });
  it("still fails when the server errors while stopping", async () => {
    expect(await runAndStop(fakeNext("process.exit(1);"))).toEqual({ code: 1, signal: null });
  });
});
