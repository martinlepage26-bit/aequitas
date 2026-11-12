import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

const restoreScript = join(import.meta.dirname, "../..", "deploy/ct920/verify-restore.sh");

type RestoreOptions = {
  appRunning?: boolean;
  invalidDump?: boolean;
  invalidEvidence?: boolean;
  schedulerRunning?: boolean;
};

function writeExecutable(path: string, contents: string) {
  writeFileSync(path, `${contents}\n`);
  chmodSync(path, 0o755);
}

function runRestore(args: string[], options: RestoreOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "aequitas-ct920-restore-"));
  const deployDir = join(root, "deploy/ct920");
  const bin = join(root, "bin");
  const log = join(root, "docker-calls.log");
  const dump = join(root, "synthetic.dump");
  const evidence = join(root, "synthetic-evidence.tar");
  mkdirSync(deployDir, { recursive: true });
  mkdirSync(bin);
  copyFileSync(restoreScript, join(deployDir, "verify-restore.sh"));
  writeFileSync(dump, "synthetic dump bytes\n");
  writeFileSync(evidence, "synthetic evidence archive bytes\n");
  writeExecutable(join(bin, "docker"), [
    "#!/bin/sh",
    "printf '%s\\n' \"$*\" >> \"$RESTORE_TEST_LOG\"",
    "case \"$*\" in",
    "  'inspect --format {{.State.Running}} aeq-prod-postgres') printf '%s\\n' true ;;",
    "  'inspect --format {{.State.Health.Status}} aeq-prod-postgres') printf '%s\\n' healthy ;;",
    "  'inspect --format {{.State.Running}} aeq-prod-app') printf '%s\\n' \"$RESTORE_TEST_APP_RUNNING\" ;;",
    "  'inspect --format {{.State.Running}} aeq-prod-scheduler')",
    "    if [ \"$RESTORE_TEST_SCHEDULER_RUNNING\" = true ]; then printf '%s\\n' true; else printf '%s\\n' false; fi",
    "    ;;",
    "  'inspect --format {{.Config.Image}} aeq-prod-app') printf '%s\\n' aeq-prod-app:synthetic ;;",
    "  'inspect --format {{range .Config.Env}}{{println .}}{{end}} aeq-prod-app') printf '%s\\n' 'DATABASE_URL=postgresql://aequitas:synthetic@aeq-prod-postgres:5432/aequitas' ;;",
    "  'volume inspect aeq-prod-evidence') exit 0 ;;",
    "  'volume inspect aeq-prod-retention-ledger') exit 0 ;;",
    "  'run --rm -i --network none --entrypoint pg_restore public.ecr.aws/docker/library/postgres:18 --list')",
    "    if [ \"$RESTORE_TEST_INVALID_DUMP\" = true ]; then exit 1; fi",
    "    ;;",
    "  'run --rm -i --network none --entrypoint tar public.ecr.aws/docker/library/postgres:18 -tf -')",
    "    if [ \"$RESTORE_TEST_INVALID_EVIDENCE\" = true ]; then exit 1; fi",
    "    ;;",
    "  *) printf 'unexpected docker call: %s\\n' \"$*\" >&2; exit 90 ;;",
    "esac",
  ].join("\n"));

  const result = spawnSync("bash", [join(deployDir, "verify-restore.sh"), ...args.map((arg) => {
    if (arg === "<dump>") return dump;
    if (arg === "<evidence>") return evidence;
    return arg;
  })], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      RESTORE_TEST_LOG: log,
      RESTORE_TEST_APP_RUNNING: String(options.appRunning ?? false),
      RESTORE_TEST_INVALID_DUMP: String(options.invalidDump ?? false),
      RESTORE_TEST_INVALID_EVIDENCE: String(options.invalidEvidence ?? false),
      RESTORE_TEST_SCHEDULER_RUNNING: String(options.schedulerRunning ?? false),
    },
  });
  const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];
  rmSync(root, { recursive: true, force: true });
  return { ...result, calls };
}

describe("CT920 production restore safety", () => {
  it("requires an explicit production-replacement flag before invoking Docker", () => {
    const result = runRestore(["<dump>"]);

    expect(result.status).toBe(64);
    expect(result.stderr).toContain("explicit flag and typed interactive confirmation are required");
    expect(result.calls).toEqual([]);
  });

  it("refuses to replace the database while the production app is running", () => {
    const result = runRestore(["--confirm-production-replacement", "<dump>"], { appRunning: true });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("stop the production app before restoring");
    expect(result.calls.some((call) => call.includes("DROP SCHEMA") || call.includes("pg_restore"))).toBe(false);
  });

  it("refuses to replace the database while the production scheduler is running", () => {
    const result = runRestore(["--confirm-production-replacement", "<dump>"], { schedulerRunning: true });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("stop the production scheduler before restoring");
    expect(result.calls.some((call) => call.includes("DROP SCHEMA") || call.includes("pg_restore"))).toBe(false);
  });

  it("validates the dump before any production database write", () => {
    const result = runRestore(["--confirm-production-replacement", "<dump>"], { invalidDump: true });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("not a readable PostgreSQL custom-format archive");
    expect(result.calls.some((call) => call.includes("DROP SCHEMA") || (call.includes("pg_restore") && !call.includes("--list")))).toBe(false);
  });

  it("validates the evidence archive before replacing production data", () => {
    const result = runRestore(["--confirm-production-replacement", "<dump>", "<evidence>"], { invalidEvidence: true });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("evidence archive is unreadable");
    expect(result.calls.some((call) => call.includes("DROP SCHEMA") || call.includes("aeq-prod-evidence:/data"))).toBe(false);
  });

  it("refuses non-interactive execution before any database or evidence write", () => {
    const result = runRestore(["--confirm-production-replacement", "<dump>"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("an interactive terminal is required");
    expect(result.calls.some((call) => call.includes("DROP SCHEMA") || (call.includes("pg_restore") && !call.includes("--list")) || call.includes("aeq-prod-evidence:/data") || call.includes("aeq-prod-net"))).toBe(false);
  });
});
