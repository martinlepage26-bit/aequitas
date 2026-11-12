import "../src/lib/loadEnv";
import { assertRetentionRestoreSafe } from "../src/domain/retentionLedger";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { prisma } from "../src/lib/prisma";
import {
  scheduledOperationsPlan,
  scheduledOperationsWithStalledChildren,
  SCHEDULED_OPERATIONS,
  type ScheduledOperationName,
  type ScheduledOperationHeartbeatSnapshot,
} from "../src/domain/scheduledOperations";

type ScheduledOperation = (typeof SCHEDULED_OPERATIONS)[number];
type RuntimeOperation = ScheduledOperation & {
  timer: ReturnType<typeof setTimeout> | null;
  child: ChildProcess | null;
  childStartedAt: Date | null;
  starting: boolean;
  heartbeatWrite: Promise<void>;
};

const STALL_WATCH_INTERVAL_MS = 30_000;

const operations: RuntimeOperation[] = SCHEDULED_OPERATIONS.map((operation) => ({
  ...operation,
  timer: null,
  child: null,
  childStartedAt: null,
  starting: false,
  heartbeatWrite: Promise.resolve(),
}));
const tsxCli = resolve(process.cwd(), "node_modules/tsx/dist/cli.mjs");
let stopping = false;
let disconnecting = false;
let stallWatchTimer: ReturnType<typeof setInterval> | null = null;
let checkingForStalls = false;

function log(fields: Record<string, string | number | null>) {
  console.log(JSON.stringify({ at: new Date().toISOString(), ...fields }));
}

function isScheduledOperationName(value: string): value is ScheduledOperationName {
  return SCHEDULED_OPERATIONS.some((operation) => operation.name === value);
}

function persistHeartbeat(operation: RuntimeOperation, data: {
  lastStartedAt?: Date;
  lastHeartbeatAt?: Date;
  lastFinishedAt?: Date;
  lastSuccessfulAt?: Date;
  lastOutcome: "RUNNING" | "SUCCEEDED" | "FAILED" | "INTERRUPTED";
  lastExitCode?: number | null;
}) {
  operation.heartbeatWrite = operation.heartbeatWrite.then(async () => {
    await prisma.scheduledOperationHeartbeat.upsert({
      where: { name: operation.name },
      create: {
        name: operation.name,
        intervalMs: operation.intervalMs,
        lastStartedAt: data.lastStartedAt,
        lastHeartbeatAt: data.lastHeartbeatAt,
        lastFinishedAt: data.lastFinishedAt,
        lastSuccessfulAt: data.lastSuccessfulAt,
        lastOutcome: data.lastOutcome,
        lastExitCode: data.lastExitCode,
      },
      update: { intervalMs: operation.intervalMs, ...data },
    });
  }).catch(() => {
    // Keep work moving if the monitoring write fails; logs contain no case data.
    log({ operation: operation.name, event: "heartbeat_write_failed" });
  });
  return operation.heartbeatWrite;
}

async function disconnectIfStopped() {
  if (!stopping || disconnecting || operations.some((operation) => operation.child || operation.starting)) return;
  disconnecting = true;
  await Promise.all(operations.map((operation) => operation.heartbeatWrite));
  await prisma.$disconnect().catch(() => undefined);
}

function schedule(operation: RuntimeOperation, delayMs: number) {
  if (stopping) return;
  operation.timer = setTimeout(() => {
    operation.timer = null;
    run(operation);
  }, delayMs);
}

async function checkForStalledChildren() {
  if (stopping || checkingForStalls) return;
  checkingForStalls = true;
  try {
    const activeNames = operations.filter((operation) => operation.child && operation.childStartedAt).map((operation) => operation.name);
    if (activeNames.length === 0) return;
    const rows = await prisma.scheduledOperationHeartbeat.findMany({ where: { name: { in: activeNames } } });
    if (stopping) return;

    // Re-read active children after the database query so a just-finished child
    // cannot trigger a restart from a stale snapshot.
    const childStartedAt = new Map(operations.flatMap((operation) => (
      operation.child && operation.childStartedAt
        ? [[operation.name, operation.childStartedAt] as const]
        : []
    )));
    if (childStartedAt.size === 0) return;
    const heartbeats = new Map<ScheduledOperationName, ScheduledOperationHeartbeatSnapshot>(
      rows.flatMap((row) => isScheduledOperationName(row.name) ? [[row.name, row] as const] : []),
    );
    const stalled = scheduledOperationsWithStalledChildren(SCHEDULED_OPERATIONS, heartbeats, childStartedAt, new Date());
    if (stalled.length === 0) return;

    log({ event: "stalled_child_detected", operations: stalled.join(",") });
    // Docker's `restart: unless-stopped` restarts the scheduler container on
    // this non-zero exit. A healthcheck alone only marks it unhealthy.
    process.exitCode = 1;
    stop("SIGTERM");
  } catch {
    log({ event: "stall_watch_read_failed" });
  } finally {
    checkingForStalls = false;
  }
}

async function run(operation: RuntimeOperation) {
  if (stopping || operation.child || operation.starting) return;
  operation.starting = true;
  const startedAt = new Date();
  log({ operation: operation.name, event: "started" });
  await persistHeartbeat(operation, { lastStartedAt: startedAt, lastHeartbeatAt: startedAt, lastOutcome: "RUNNING", lastExitCode: null });
  if (stopping) {
    operation.starting = false;
    const finishedAt = new Date();
    await persistHeartbeat(operation, { lastHeartbeatAt: finishedAt, lastFinishedAt: finishedAt, lastOutcome: "INTERRUPTED", lastExitCode: null });
    await disconnectIfStopped();
    return;
  }
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, [tsxCli, operation.entrypoint], {
      cwd: process.cwd(),
      env: { ...process.env, AEQUITAS_SCHEDULER_OPERATION: operation.name },
      stdio: "inherit",
    });
  } catch {
    operation.starting = false;
    log({ operation: operation.name, event: "start_failed" });
    const finishedAt = new Date();
    await persistHeartbeat(operation, { lastStartedAt: startedAt, lastHeartbeatAt: finishedAt, lastFinishedAt: finishedAt, lastOutcome: "FAILED", lastExitCode: null });
    schedule(operation, operation.intervalMs);
    await disconnectIfStopped();
    return;
  }
  operation.child = child;
  operation.childStartedAt = startedAt;
  operation.starting = false;
  let startFailed = false;
  let finalized = false;
  const finish = (code: number | null, signal: NodeJS.Signals | null) => {
    if (finalized) return;
    finalized = true;
    operation.child = null;
    operation.childStartedAt = null;
    const outcome = stopping && (signal === "SIGTERM" || signal === "SIGINT")
      ? "INTERRUPTED"
      : !startFailed && code === 0 && signal === null
        ? "SUCCEEDED"
        : "FAILED";
    const finishedAt = new Date();
    log({ operation: operation.name, event: startFailed ? "start_failed" : "finished", exit_code: code, signal });
    void persistHeartbeat(operation, {
      lastStartedAt: startedAt,
      lastHeartbeatAt: finishedAt,
      lastFinishedAt: finishedAt,
      ...(outcome === "SUCCEEDED" ? { lastSuccessfulAt: finishedAt } : {}),
      lastOutcome: outcome,
      lastExitCode: code,
    }).then(async () => {
      schedule(operation, operation.intervalMs);
      await disconnectIfStopped();
    });
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
  if (stallWatchTimer) clearInterval(stallWatchTimer);
  stallWatchTimer = null;
  for (const operation of operations) {
    if (operation.timer) clearTimeout(operation.timer);
    operation.timer = null;
    operation.child?.kill(signal);
  }
  const forceStop = setTimeout(() => {
    for (const operation of operations) operation.child?.kill("SIGKILL");
  }, 25_000);
  forceStop.unref();
  void disconnectIfStopped();
}

if (process.argv.includes("--print-plan")) {
  console.log(JSON.stringify({ operations: scheduledOperationsPlan() }));
} else {
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
  assertRetentionRestoreSafe().then(() => {
    if (stopping) return;
    stallWatchTimer = setInterval(() => { void checkForStalledChildren(); }, STALL_WATCH_INTERVAL_MS);
    stallWatchTimer.unref();
    for (const operation of operations) schedule(operation, 0);
  }).catch(async () => { console.error("RETENTION_RESTORE_CHECK_FAILED"); process.exitCode = 1; await prisma.$disconnect(); });
}
