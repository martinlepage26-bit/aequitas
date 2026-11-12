import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

const script = join(import.meta.dirname, "../..", "deploy/ct920/verify-restore-isolated.sh");
const fakeDocker = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const root = process.env.RESTORE_TEST_ROOT;
const mode = process.env.RESTORE_TEST_MODE;
const file = root + '/state.json';
const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { container: {}, volume: {}, network: {} };
fs.appendFileSync(root + '/calls.jsonl', JSON.stringify(args) + '\\n');
const save = () => fs.writeFileSync(file, JSON.stringify(state));
const value = flag => args[args.indexOf(flag) + 1];
const done = (output = '', code = 0) => { save(); if (output) process.stdout.write(output + '\\n'); process.exit(code); };
const [kind, action] = args;
if (kind === 'image' && action === 'inspect') done('sha256:' + (args.at(-1).includes('postgres') ? 'b' : 'a').repeat(64));
if (action === 'inspect') {
  const name = args.at(-1);
  if (args.includes('--format')) {
    if (mode === 'ownership' && kind === 'volume') { state.volume[name] = 'someone-else'; done('someone-else'); }
    done((state[kind][name] || '').split('=').at(-1));
  }
  if (mode === 'collision' && kind === 'volume') done('existing', 0);
  done('', state[kind][name] ? 0 : 1);
}
if (action === 'create') { state[kind][args.at(-1)] = value('--label'); done(args.at(-1)); }
if (action === 'ls') done(Object.keys(state[kind]).filter(name => state[kind][name] === value('--filter').slice(6)).join('\\n'));
if (action === 'rm') {
  if (mode === 'cleanup' && kind === 'volume') done('', 1);
  delete state[kind][args.at(-1)]; done();
}
if (kind === 'run') {
  if (args.includes('--env-file')) {
    const env = fs.readFileSync(value('--env-file'), 'utf8').trim().split('\\n');
    fs.appendFileSync(root + '/env-checks.jsonl', JSON.stringify({
      keys: env.map(line => line.split('=')[0]),
      databaseIsIsolated: !env.some(line => line.startsWith('DATABASE_URL=')) || env.some(line => /^DATABASE_URL=postgresql:\\/\\/aequitas:[a-f0-9]{64}@aeq-restore-drill-[a-f0-9]{32}-db:5432\\/aequitas$/.test(line)),
      readOnly: env.includes('PGOPTIONS=-c default_transaction_read_only=on'),
      privateMode: (fs.statSync(value('--env-file')).mode & 0o777) === 0o600,
    }) + '\\n');
  }
  if (args.includes('-d')) { state.container[value('--name')] = value('--label'); done('container-id'); }
  if (mode === 'dump' && args.includes('--list')) done('', 1);
  if (mode === 'archive' && args.includes('-tf')) done('', 1);
  if (mode === 'verify' && args.includes('scripts/verify-events.ts')) done('', 1);
  done();
}
if (kind === 'exec') {
  if (mode === 'restore' && args.includes('pg_restore')) done('', 1);
  if (args.includes('psql')) done('Case 1\\nEvent 2');
  done();
}
done('unexpected docker invocation', 90);
`;

function run(mode = "success", suppliedArgs?: string[]) {
  const root = mkdtempSync(join(tmpdir(), "aequitas-isolated-test-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  mkdirSync(join(root, "temporary"));
  writeFileSync(join(bin, "docker"), fakeDocker);
  chmodSync(join(bin, "docker"), 0o755);
  const dump = join(root, "backup.dump");
  const evidence = join(root, "evidence.tar");
  writeFileSync(dump, "synthetic backup");
  writeFileSync(evidence, "synthetic evidence");
  const result = spawnSync("bash", [script, ...(suppliedArgs ?? ["--app-image", "local-app:test", dump, evidence])], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      TMPDIR: join(root, "temporary"),
      RESTORE_TEST_ROOT: root,
      RESTORE_TEST_MODE: mode,
      // Host credentials/target settings must not be copied to the drill.
      DATABASE_URL: "postgresql://production-secret@production/aequitas",
      RESEND_API_KEY: "production-email-secret",
      COMPOSE_PROJECT_NAME: "aeq-prod",
      HASH_CHAIN_GENESIS: "0".repeat(64),
    },
  });
  const readLines = (name: string) => existsSync(join(root, name))
    ? readFileSync(join(root, name), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  const calls = readLines("calls.jsonl") as string[][];
  const envChecks = readLines("env-checks.jsonl") as { keys: string[]; databaseIsIsolated: boolean; readOnly: boolean; privateMode: boolean }[];
  const state = existsSync(join(root, "state.json")) ? JSON.parse(readFileSync(join(root, "state.json"), "utf8")) as Record<string, Record<string, string>> : {};
  const temporaryFiles = spawnSync("find", [join(root, "temporary"), "-mindepth", "1"], { encoding: "utf8" }).stdout.trim();
  rmSync(root, { recursive: true, force: true });
  return { ...result, calls, envChecks, state, temporaryFiles };
}

describe("isolated CT920 restore drill", () => {
  it("requires explicit image and two archives before invoking Docker", () => {
    const result = run("success", ["--confirm-production-replacement", "backup.dump"]);
    expect(result.status).toBe(64);
    expect(result.calls).toEqual([]);
  });

  it("restores and verifies only fresh isolated resources, then removes them and temporary secrets", () => {
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Isolated restore verification passed");
    expect(result.calls.flat().some(value => value.includes("aeq-prod"))).toBe(false);
    expect(result.calls.some(call => call.includes("--internal"))).toBe(true);
    expect(result.calls.some(call => call.includes("-p") || call.includes("--publish") || call.includes("compose"))).toBe(false);
    expect(result.calls.filter(call => call.includes("--mount")).flat().filter(value => value.startsWith("type=volume,")).every(value => value.startsWith("type=volume,source=aeq-restore-drill-"))).toBe(true);
    expect(result.envChecks.every(check => check.privateMode && check.databaseIsIsolated)).toBe(true);
    expect(result.envChecks.filter(check => check.keys.includes("DATABASE_URL")).every(check => check.readOnly && check.keys.join(",") === "DATABASE_URL,STORAGE_LOCAL_DIR,HASH_CHAIN_GENESIS,PGOPTIONS")).toBe(true);
    expect(result.calls.filter(call => call.includes("scripts/verify-events.ts") || call.includes("scripts/verify-evidence-files.ts")).every(call => call.includes("--read-only") && call.some(value => value.endsWith("target=/data,readonly")))).toBe(true);
    expect(result.state).toEqual({ container: {}, volume: {}, network: {} });
    expect(result.temporaryFiles).toBe("");
    expect(result.stdout + result.stderr).not.toContain("production-secret");
  });

  it.each(["dump", "archive"])("rejects an invalid %s before creating a database or volumes", (mode) => {
    const result = run(mode);
    expect(result.status).toBe(1);
    expect(result.calls.some(call => call.includes("create") || call.includes("-d"))).toBe(false);
    expect(result.temporaryFiles).toBe("");
  });

  it.each(["restore", "verify"])("cleans up every owned resource after a %s failure", (mode) => {
    const result = run(mode);
    expect(result.status).toBe(1);
    expect(result.state).toEqual({ container: {}, volume: {}, network: {} });
    expect(result.temporaryFiles).toBe("");
    expect(result.stdout).not.toContain("verification passed");
  });

  it("refuses existing generated names without mounting or removing them", () => {
    const result = run("collision");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("volume name already exists");
    expect(result.calls.some(call => call.includes("create") || call.includes("run") || call.includes("rm"))).toBe(false);
  });

  it("refuses a volume ownership race and preserves the other owner's resource", () => {
    const result = run("ownership");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("not owned by this drill");
    expect(Object.values(result.state.volume)).toEqual(["someone-else"]);
    expect(result.calls.some(call => call.includes("--mount"))).toBe(false);
    expect(result.state.network).toEqual({});
  });

  it("reports cleanup failure and returns nonzero even after successful verification", () => {
    const result = run("cleanup");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Cleanup incomplete for ownership label");
    expect(Object.keys(result.state.volume)).toHaveLength(2);
    expect(result.temporaryFiles).toBe("");
  });
});
