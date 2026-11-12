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
  missingPurger?: boolean;
  runtimeUnavailable?: boolean;
  rolesInvalid?: boolean;
  interactive?: boolean;
  provisionFails?: boolean;
  migrationFails?: boolean;
  genesis?: string;
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
  mkdirSync(join(root, "deploy/retention"));
  for (const file of ["validate-restore-roles.sql", "provision-purger.sql", "grant-restored-runtime.sql"]) {
    copyFileSync(join(import.meta.dirname, "../../deploy/retention", file), join(root, "deploy/retention", file));
  }
  copyFileSync(join(import.meta.dirname, "../../deploy/ct920/row-counts.sql"), join(deployDir, "row-counts.sql"));
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
    "  'inspect --format {{.Image}} aeq-prod-app') printf 'sha256:%064d\\n' 1 ;;",
    "  'inspect --format {{range .Config.Env}}{{println .}}{{end}} aeq-prod-app') printf '%s\\n' 'DATABASE_URL=postgresql://runtime_blue:synthetic@aeq-prod-postgres:5432/aequitas' \"HASH_CHAIN_GENESIS=$RESTORE_TEST_GENESIS\" ;;",
    "  *'--input-type=module'*) if [ \"$RESTORE_TEST_RUNTIME_UNAVAILABLE\" = true ]; then exit 1; fi; printf '%s' runtime_blue ;;",
    "  'exec -i aeq-prod-postgres psql '*'-v runtime_role=runtime_blue'*)",
    "    sql=$(cat)",
    "    case \"$sql\" in",
    "      *'BEGIN READ ONLY'*) printf 'ROLE_PREFLIGHT\\n' >> \"$RESTORE_TEST_LOG\"; if [ \"$RESTORE_TEST_ROLES_INVALID\" = true ]; then exit 1; fi ;;",
    "      *'ALTER FUNCTION'*) printf 'PROVISION_PURGER\\n' >> \"$RESTORE_TEST_LOG\"; if [ \"$RESTORE_TEST_PROVISION_FAILS\" = true ]; then exit 1; fi ;;",
    "      *'ALTER DEFAULT PRIVILEGES'*) printf 'RUNTIME_GRANTS\\n' >> \"$RESTORE_TEST_LOG\" ;;",
    "      *) exit 91 ;;",
    "    esac ;;",
    "  'exec -i aeq-prod-postgres psql '*' -c '*) exit 0 ;;",
    "  'exec -i aeq-prod-postgres psql '* | 'exec -i aeq-prod-postgres pg_restore '*) cat >/dev/null ;;",
    "  'run --rm --network aeq-prod-net '*)",
    "    previous=''; for arg in \"$@\"; do if [ \"$previous\" = --env-file ]; then cp \"$arg\" \"$RESTORE_TEST_CAPTURE_ENV\"; fi; previous=$arg; done",
    "    case \"$*\" in *'migrate status') if [ \"$RESTORE_TEST_MIGRATION_FAILS\" = true ]; then exit 1; fi ;; esac ;;",
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

  const scriptArgs = args.flatMap(arg => arg === "--confirm-production-replacement" && !options.missingPurger
    ? [arg, "--purger-role", "purger_green"] : [arg]).map(arg => arg === "<dump>" ? dump : arg === "<evidence>" ? evidence : arg);
  const env = {
    ...process.env,
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    RESTORE_TEST_LOG: log,
    RESTORE_TEST_CAPTURE_ENV: join(root, "captured.env"),
    RESTORE_TEST_APP_RUNNING: String(options.appRunning ?? false),
    RESTORE_TEST_INVALID_DUMP: String(options.invalidDump ?? false),
    RESTORE_TEST_INVALID_EVIDENCE: String(options.invalidEvidence ?? false),
    RESTORE_TEST_SCHEDULER_RUNNING: String(options.schedulerRunning ?? false),
    RESTORE_TEST_RUNTIME_UNAVAILABLE: String(options.runtimeUnavailable ?? false),
    RESTORE_TEST_ROLES_INVALID: String(options.rolesInvalid ?? false),
    RESTORE_TEST_PROVISION_FAILS: String(options.provisionFails ?? false),
    RESTORE_TEST_MIGRATION_FAILS: String(options.migrationFails ?? false),
    RESTORE_TEST_GENESIS: options.genesis ?? "ab".repeat(32),
  };
  const command = [join(deployDir, "verify-restore.sh"), ...scriptArgs];
  const ptyDriver = `
import os, pty, select, sys, time
pid, fd = pty.fork()
if pid == 0:
    os.execvp("bash", ["bash", *sys.argv[1:]])
output = b""
sent = False
deadline = time.monotonic() + 10
while time.monotonic() < deadline:
    if select.select([fd], [], [], 0.1)[0]:
        try: chunk = os.read(fd, 65536)
        except OSError: break
        if not chunk: break
        output += chunk
        if not sent and b'to continue:' in output:
            os.write(fd, b'REPLACE AEQUITAS PRODUCTION DATABASE\\n')
            sent = True
else:
    os.kill(pid, 9)
_, status = os.waitpid(pid, 0)
sys.stdout.buffer.write(output)
sys.exit(os.waitstatus_to_exitcode(status))
`;
  const result = spawnSync(options.interactive ? "python3" : "bash", options.interactive ? ["-c", ptyDriver, ...command] : command, {
    cwd: root, encoding: "utf8", env, timeout: 15_000,
  });
  const capturedEnv = existsSync(join(root, "captured.env")) ? readFileSync(join(root, "captured.env"), "utf8") : "";
  const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];
  rmSync(root, { recursive: true, force: true });
  return { ...result, calls, capturedEnv };
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
    expect(result.calls.some((call) => call.includes("DROP SCHEMA") || (call.includes("pg_restore") && !call.includes("--list")) || call.includes("aeq-prod-evidence:/data"))).toBe(false);
  });
});


describe("CT920 restored permission boundaries", () => {
  it("requires the actual operator-selected purger identity", () => {
    const result = runRestore(["--confirm-production-replacement", "<dump>"], { missingPurger: true });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("explicit existing --purger-role");
    expect(result.calls).toEqual([]);
  });
  it.each([{ runtimeUnavailable: true }, { rolesInvalid: true }, { genesis: "invalid" }, { genesis: "" }])("refuses preflight failure before any destructive command: %j", options => {
    const result = runRestore(["--confirm-production-replacement", "<dump>"], options);
    expect(result.status).toBe(1);
    expect(result.calls.some(call => call.includes("DROP SCHEMA") || (call.includes("pg_restore") && !call.includes("--list")))).toBe(false);
  });
  it("restores role grants and purge ownership before verification, preserving nonzero genesis", () => {
    const result = runRestore(["--confirm-production-replacement", "<dump>"], { interactive: true });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const restored = result.calls.findIndex(call => call.includes("pg_restore") && call.includes("--no-owner"));
    const provisioned = result.calls.indexOf("PROVISION_PURGER");
    const grants = result.calls.indexOf("RUNTIME_GRANTS");
    const migrations = result.calls.findIndex(call => call.includes("migrate status"));
    expect(result.calls.indexOf("ROLE_PREFLIGHT")).toBeLessThan(restored);
    expect(provisioned).toBeGreaterThan(restored);
    expect(grants).toBeGreaterThan(provisioned);
    expect(migrations).toBeGreaterThan(grants);
    expect(result.calls.some(call => call.includes("runtime_role=runtime_blue") && call.includes("purger_role=purger_green"))).toBe(true);
    expect(result.calls.some(call => call.includes("verify-runtime-role.mjs"))).toBe(true);
    expect(result.calls.some(call => call.includes("retention-restore.ts verify"))).toBe(true);
    expect(result.capturedEnv).toContain(`HASH_CHAIN_GENESIS=${"ab".repeat(32)}`);
    expect(result.capturedEnv).not.toMatch(/PURGER|POSTGRES_PASSWORD|SESSION_SECRET/);
    expect(result.stdout + result.stderr).not.toContain("postgresql://");
    expect(result.calls.some(call => /compose.*up| start /.test(call))).toBe(false);
  });
  it.each([{ provisionFails: true }, { migrationFails: true }])("keeps writers stopped and never reports successful incompatible/failed restore: %j", options => {
    const result = runRestore(["--confirm-production-replacement", "<dump>"], { ...options, interactive: true });
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain("Restore verification complete");
    expect(result.calls.some(call => /compose.*up| start /.test(call))).toBe(false);
  });
});
