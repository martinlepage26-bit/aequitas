import { chmodSync, copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

const deployScript = join(import.meta.dirname, "../..", "deploy/ct920/deploy.sh");

type DeployOptions = {
  appHealthy?: boolean;
  schedulerExists?: boolean;
  schedulerState?: "running" | "exited";
  schedulerReady?: boolean;
};

function writeExecutable(path: string, contents: string) {
  writeFileSync(path, `${contents}\n`);
  chmodSync(path, 0o755);
}

function runDeployment(options: DeployOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "aequitas-ct920-deploy-"));
  const project = join(root, "repo");
  const deployDir = join(project, "deploy/ct920");
  const bin = join(root, "bin");
  const log = join(root, "calls.log");
  mkdirSync(deployDir, { recursive: true });
  mkdirSync(bin);
  copyFileSync(deployScript, join(deployDir, "deploy.sh"));
  writeFileSync(join(deployDir, ".env"), "synthetic=only\n");
  chmodSync(join(deployDir, ".env"), 0o600);

  writeExecutable(join(bin, "git"), "#!/bin/sh\nprintf '%s\\n' 'synthetic-release'");
  writeExecutable(join(bin, "stat"), "#!/bin/sh\nprintf '%s\\n' '600'");
  writeExecutable(join(bin, "sleep"), "#!/bin/sh\nexit 0");
  writeExecutable(join(bin, "curl"), [
    "#!/bin/sh",
    "printf '%s\\n' 'curl' >> \"$DEPLOY_TEST_LOG\"",
    "if [ \"$DEPLOY_TEST_APP_HEALTHY\" = 'true' ]; then",
    "  printf '%s\\n' '{\"status\":\"ok\",\"release\":\"synthetic-release\"}'",
    "else",
    "  printf '%s\\n' '{\"status\":\"ok\",\"release\":\"old-release\"}'",
    "fi",
  ].join("\n"));
  writeExecutable(join(bin, "docker"), [
    "#!/bin/sh",
    "printf '%s\\n' \"$*\" >> \"$DEPLOY_TEST_LOG\"",
    "case \"$*\" in",
    "  'compose -p aeq-prod --profile scheduled ps -a -q scheduler')",
    "    if [ \"$DEPLOY_TEST_SCHEDULER_EXISTS\" = 'true' ]; then printf '%s\\n' 'synthetic-container-id'; fi",
    "    ;;",
    "  'inspect --format {{.State.Status}} aeq-prod-scheduler')",
    "    printf '%s\\n' \"$DEPLOY_TEST_SCHEDULER_STATE\"",
    "    ;;",
    "  'compose -p aeq-prod --profile scheduled exec -T -e SCHEDULER_READY_SINCE='*' scheduler node node_modules/tsx/dist/cli.mjs scripts/verify-scheduled-ops.ts')",
    "    if [ \"$DEPLOY_TEST_SCHEDULER_READY\" != 'true' ]; then exit 1; fi",
    "    ;;",
    "esac",
  ].join("\n"));

  const result = spawnSync("bash", [join(deployDir, "deploy.sh")], {
    cwd: project,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      DEPLOY_TEST_LOG: log,
      DEPLOY_TEST_APP_HEALTHY: String(options.appHealthy ?? true),
      DEPLOY_TEST_SCHEDULER_EXISTS: String(options.schedulerExists ?? false),
      DEPLOY_TEST_SCHEDULER_STATE: options.schedulerState ?? "running",
      DEPLOY_TEST_SCHEDULER_READY: String(options.schedulerReady ?? true),
    },
  });
  const calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
  rmSync(root, { recursive: true, force: true });
  return { ...result, calls };
}

describe("CT920 deployment scheduled operations", () => {
  it("starts the scheduler only after the new app reports its release healthy", () => {
    const result = runDeployment();
    const schedulerStart = result.calls.indexOf("compose -p aeq-prod --profile scheduled up -d scheduler");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("scheduled operations are healthy on release synthetic-release");
    expect(result.calls).toContain("compose -p aeq-prod build app evidence-parser");
    expect(schedulerStart).toBeGreaterThan(-1);
    expect(result.calls.lastIndexOf("curl")).toBeLessThan(schedulerStart);
    expect(result.calls.some((call) => call.includes("scripts/verify-scheduled-ops.ts"))).toBe(true);
  });

  it("stops an existing worker before migrations and restarts it on the verified release", () => {
    const result = runDeployment({ schedulerExists: true });
    const stop = result.calls.indexOf("compose -p aeq-prod --profile scheduled stop scheduler");
    const migrate = result.calls.findIndex((call) => call.includes("node node_modules/prisma/build/index.js migrate deploy"));
    const start = result.calls.indexOf("compose -p aeq-prod --profile scheduled up -d scheduler");

    expect(result.status).toBe(0);
    expect(stop).toBeGreaterThan(-1);
    expect(stop).toBeLessThan(migrate);
    expect(migrate).toBeLessThan(start);
    expect(result.calls.lastIndexOf("curl")).toBeLessThan(start);
  });

  it("does not start the scheduler when the app release health check fails", () => {
    const result = runDeployment({ appHealthy: false });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("health did not report synthetic-release");
    expect(result.calls).not.toContain("compose -p aeq-prod --profile scheduled up -d scheduler");
  });

  it("fails deployment when the scheduled worker does not remain running", () => {
    const result = runDeployment({ schedulerState: "exited" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("scheduled operations did not start");
  });

  it("fails deployment when either scheduled operation does not pass its release heartbeat", () => {
    const result = runDeployment({ schedulerReady: false });

    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain("scheduled operations are healthy");
    expect(result.calls.some((call) => call.includes("scripts/verify-scheduled-ops.ts"))).toBe(true);
  });
});
