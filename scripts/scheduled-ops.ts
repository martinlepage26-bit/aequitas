import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { scheduledOperationsPlan, SCHEDULED_OPERATIONS } from "../src/domain/scheduledOperations";

type ScheduledOperation = (typeof SCHEDULED_OPERATIONS)[number];
type RuntimeOperation = ScheduledOperation & { timer: ReturnType<typeof setTimeout> | null; child: ChildProcess | null };

const operations: RuntimeOperation[] = SCHEDULED_OPERATIONS.map((operation) => ({ ...operation, timer: null, child: null }));
const tsxCli = resolve(process.cwd(), "node_modules/tsx/dist/cli.mjs");
let stopping = false;

function log(fields: Record<string, string | number | null>) {
  console.log(JSON.stringify({ at: new Date().toISOString(), ...fields }));
}

function schedule(operation: RuntimeOperation, delayMs: number) {
  if (stopping) return;
  operation.timer = setTimeout(() => {
    operation.timer = null;
    run(operation);
  }, delayMs);
}

function run(operation: RuntimeOperation) {
  if (stopping || operation.child) return;
  log({ operation: operation.name, event: "started" });
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, [tsxCli, operation.entrypoint], {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    });
  } catch {
    log({ operation: operation.name, event: "start_failed" });
    schedule(operation, operation.intervalMs);
    return;
  }
  operation.child = child;
  let startFailed = false;
  let finalized = false;
  const finish = (code: number | null, signal: NodeJS.Signals | null) => {
    if (finalized) return;
    finalized = true;
    operation.child = null;
    log({ operation: operation.name, event: startFailed ? "start_failed" : "finished", exit_code: code, signal });
    schedule(operation, operation.intervalMs);
  };
  child.once("error", () => {
    startFailed = true;
    finish(null, null);
  });
  child.once("close", finish);
}

function stop(signal: NodeJS.Signals) {
  if (stopping) return;
  stopping = true;
  for (const operation of operations) {
    if (operation.timer) clearTimeout(operation.timer);
    operation.timer = null;
    operation.child?.kill(signal);
  }
  const forceStop = setTimeout(() => {
    for (const operation of operations) operation.child?.kill("SIGKILL");
  }, 25_000);
  forceStop.unref();
}

if (process.argv.includes("--print-plan")) {
  console.log(JSON.stringify({ operations: scheduledOperationsPlan() }));
} else {
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
  for (const operation of operations) schedule(operation, 0);
}
