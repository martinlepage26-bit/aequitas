import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("explicit retention restore verification", () => {
  it.each([undefined, "false", "true"])("fails without an independent ledger when enforcement is %s", enabled => {
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      // Neither the missing-ledger check nor this negative CLI test needs a DB.
      DATABASE_URL: "postgresql://unavailable@127.0.0.1:1/retention_cli_test",
      RETENTION_LEDGER_PATH: join(tmpdir(), `missing-retention-ledger-${randomUUID()}.json`),
    };
    if (enabled === undefined) delete environment.RETENTION_ENFORCEMENT_ENABLED;
    else environment.RETENTION_ENFORCEMENT_ENABLED = enabled;
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/retention-restore.ts", "verify"], {
      cwd: process.cwd(), env: environment, encoding: "utf8", timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("RETENTION_RESTORE_CHECK_FAILED");
    expect(result.stdout).not.toContain('"status":"passed"');
  });
});
