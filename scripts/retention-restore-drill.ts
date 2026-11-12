/** Real, disposable database + object-snapshot restore drill. All databases
 * are uniquely created by this process; existing databases are never restored
 * into, modified or removed. No model, email or remote object store is used. */
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const script = fileURLToPath(import.meta.url);
const repository = fileURLToPath(new URL("../", import.meta.url));
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const proof = sha256("Synthetic isolated restoration proof");
function ensure(condition: unknown, code: string): asserts condition { if (!condition) throw new Error(code); }
function connection(envName: string) {
  const raw = process.env[envName];
  ensure(raw, `${envName}_REQUIRED`);
  const url = new URL(raw);
  ensure(url.protocol === "postgresql:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname), "DRILL_REQUIRES_EXPLICIT_LOCAL_TEST_SERVER");
  return url;
}
function dbUrl(base: URL, database: string) { const value = new URL(base); value.pathname = `/${database}`; return value.toString(); }
function pgEnvironment(base: URL, database: string, container: boolean): NodeJS.ProcessEnv {
  return { ...process.env, PGHOST: container ? "127.0.0.1" : base.hostname, PGPORT: container ? "5432" : base.port || "5432", PGUSER: decodeURIComponent(base.username), PGPASSWORD: decodeURIComponent(base.password), PGDATABASE: database };
}
function pgTool(base: URL, database: string, name: string, args: string[], input?: Buffer | string): Buffer {
  const container = process.env.RETENTION_DRILL_PG_CONTAINER;
  const env = pgEnvironment(base, database, Boolean(container));
  if (container) {
    ensure(/^[A-Za-z0-9_.-]+$/.test(container), "INVALID_TEST_CONTAINER");
    return execFileSync("docker", ["exec", "-i", ...["PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGDATABASE"].flatMap(key => ["-e", key]), container, name, ...args], { env, input, maxBuffer: 64 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"], timeout: 120_000 });
  }
  const path = process.env.PG_BINDIR ? join(process.env.PG_BINDIR, name) : name;
  return execFileSync(path, args, { env, input, maxBuffer: 64 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"], timeout: 120_000 });
}
function runPhase(name: string, env: NodeJS.ProcessEnv) {
  const output = execFileSync(process.execPath, ["--import", "tsx", script, "--phase", name], { cwd: repository, env, stdio: ["ignore", "pipe", "pipe"], timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  const line = output.toString("utf8").trim().split("\n").at(-1);
  ensure(line, `DRILL_PHASE_${name}_MISSING_RECEIPT`);
  return JSON.parse(line) as Record<string, unknown>;
}

async function phase(name: string) {
  const { prisma } = await import("../src/lib/prisma");
  const retention = await import("../src/domain/retention");
  const ledger = await import("../src/domain/retentionLedger");
  const storage = await import("../src/lib/storage");
  const manifestPath = process.env.RETENTION_DRILL_MANIFEST!;
  try {
    if (name === "seed") {
      await ledger.initializeDeletionLedger();
      const admin = await prisma.user.create({ data: { email: `drill-admin-${randomUUID()}@example.com`, displayName: "Synthetic operator", globalRole: "ADMIN" } });
      const party = await prisma.user.create({ data: { email: `drill-party-${randomUUID()}@example.com`, displayName: "Synthetic party", globalRole: "COMPLAINANT" } });
      const c = await prisma.case.create({ data: { referenceNumber: `RESTORE-${randomUUID()}`, state: "CLOSED", closedAt: new Date("2000-01-01"), complainantId: party.id, respondentId: party.id, simulated: true, disputeDescription: "Synthetic retained case restored from an old backup" } });
      const key = storage.evidenceObjectKey(true, c.id, randomUUID());
      const content = Buffer.from("Synthetic file restored from pre-erasure object snapshot");
      await storage.uploadBuffer({ storageKey: key, buffer: content, mimeType: "text/plain" });
      await prisma.evidenceItem.create({ data: { caseId: c.id, submittedById: party.id, kind: "DOCUMENT", title: "Synthetic restore evidence", storageKey: key, sha256: sha256(content), byteSize: content.length, mimeType: "text/plain", simulated: true, scanStatus: "CLEAN" } });
      const { appendEvent } = await import("../src/domain/events");
      await prisma.$transaction(tx => appendEvent(tx, { caseId: c.id, actorId: party.id, type: "CASE_CREATED", payload: { historicalContent: "Synthetic old event payload" } }));
      // Snapshot predates the request, hold, approval and external tombstone.
      await writeFile(manifestPath, JSON.stringify({ caseId: c.id, actorId: admin.id, partyId: party.id, key, contentDigest: sha256(content) }), { mode: 0o600, flag: "wx" });
      console.log(JSON.stringify({ phase: name, caseCreated: true, objects: 1, events: 1 }));
      return;
    }
    const fixture = JSON.parse(await readFile(manifestPath, "utf8")) as { caseId: string; actorId: string; partyId: string; key: string; contentDigest: string };
    if (name === "erase") {
      const job = await retention.requestCaseDeletion(fixture.caseId, fixture.partyId);
      await retention.reviewDeletionHold(job.id, fixture.actorId, "CLEAR", proof);
      await retention.approveCaseDeletion(job.id, fixture.actorId, proof);
      await retention.freezeCaseDeletion(job.id, fixture.actorId);
      await retention.inventoryCaseDeletion(job.id, fixture.actorId);
      await retention.eraseCaseDeletionObjects(job.id, fixture.actorId);
      await retention.purgeCaseDeletionDatabase(job.id, fixture.actorId);
      ensure(await prisma.case.count({ where: { id: fixture.caseId } }) === 0, "SOURCE_DATABASE_ERASURE_FAILED");
      ensure((await storage.listStoredKeysForCase(fixture.caseId, true)).length === 0, "SOURCE_OBJECT_ERASURE_FAILED");
      await ledger.assertRetentionRestoreSafe();
      console.log(JSON.stringify({ phase: name, sourceCaseAbsent: true, sourceObjectsAbsent: true, externalCopies: "PENDING" }));
      return;
    }
    if (name === "restore-object-only") {
      ensure(await prisma.case.count({ where: { id: fixture.caseId } }) === 0, "EXPECTED_POST_PURGE_DATABASE");
      ensure(sha256(await storage.downloadBuffer(fixture.key)) === fixture.contentDigest, "RESTORED_OBJECT_DIGEST_MISMATCH");
      const job = await prisma.caseDeletion.findUniqueOrThrow({ where: { caseId: fixture.caseId } });
      let blocked = false;
      try { await ledger.assertRetentionRestoreSafe(); }
      catch (error) { blocked = error instanceof Error && error.message === "RETENTION_RESTORED_OBJECTS_PENDING"; }
      ensure(blocked, "OBJECT_ONLY_RESTORE_WAS_NOT_BLOCKED");
      const ledgerDigest = sha256(await readFile(process.env.RETENTION_LEDGER_PATH!));
      let replayPending = false;
      try { await ledger.replayDeletionTombstones(fixture.actorId, ledgerDigest, true); }
      catch (error) { replayPending = error instanceof Error && error.message === "RETENTION_RESTORED_OBJECTS_PENDING"; }
      ensure(replayPending, "OBJECT_REPLAY_MUST_STAY_BLOCKED_UNTIL_RECONCILED");
      ensure((await prisma.caseDeletion.findUniqueOrThrow({ where: { id: job.id } })).restoredObjectsPending, "RESTORED_OBJECT_OBLIGATION_NOT_RECORDED");
      await retention.reviewDeletionHold(job.id, fixture.actorId, "HELD", proof);
      let holdBlocked = false;
      try { await ledger.reconcileRestoredObjects(job.id, fixture.actorId, proof, true); }
      catch (error) { holdBlocked = error instanceof Error && error.message === "RETENTION_RESTORED_OBJECTS_NOT_AUTHORIZED"; }
      ensure(holdBlocked, "OBJECT_RECONCILIATION_IGNORED_HOLD");
      await retention.reviewDeletionHold(job.id, fixture.actorId, "CLEAR", proof);
      const disposed = await ledger.reconcileRestoredObjects(job.id, fixture.actorId, proof, true);
      ensure(disposed.erasedObjects === 1, "OBJECT_RECONCILIATION_COUNT_MISMATCH");
      await ledger.assertRetentionRestoreSafe();
      ensure((await storage.listStoredKeysForCase(fixture.caseId, true)).length === 0, "RESTORED_OBJECT_STILL_PRESENT");
      let copiesPending = false;
      try { await retention.completeCaseDeletion(job.id, fixture.actorId); }
      catch (error) { copiesPending = error instanceof Error && error.message === "EXTERNAL_COPIES_PENDING"; }
      ensure(copiesPending, "RECONCILIATION_FABRICATED_GLOBAL_COMPLETION");
      console.log(JSON.stringify({ phase: name, postPurgeDatabase: true, restoredObjectDigestVerified: true, startupBlocked: true, replayRemainedBlocked: true, holdRespected: true, reviewedReconciliationErasedObject: true, externalCopies: "PENDING" }));
      return;
    }
    if (name === "restore-replay") {
      const restored = await prisma.case.findUniqueOrThrow({ where: { id: fixture.caseId } });
      ensure(restored.deletionStartedAt === null, "EXPECTED_PRE_ERASURE_SNAPSHOT");
      ensure(await prisma.caseDeletion.count({ where: { caseId: fixture.caseId } }) === 0, "SNAPSHOT_SHOULD_PREDATE_DELETION_REQUEST");
      ensure(await prisma.event.count({ where: { caseId: fixture.caseId } }) === 1, "RESTORED_EVENT_MISSING");
      ensure(sha256(await storage.downloadBuffer(fixture.key)) === fixture.contentDigest, "RESTORED_OBJECT_DIGEST_MISMATCH");
      let blocked = false;
      try { await ledger.assertRetentionRestoreSafe(); }
      catch (error) { blocked = error instanceof Error && error.message === "RETENTION_RESTORE_REPLAY_REQUIRED"; }
      ensure(blocked, "RESTORED_DATA_WAS_NOT_QUARANTINED_AT_STARTUP");
      const ledgerDigest = sha256(await readFile(process.env.RETENTION_LEDGER_PATH!));
      const result = await ledger.replayDeletionTombstones(fixture.actorId, ledgerDigest, true);
      ensure(result.quarantined === 1, "RESTORE_REPLAY_COUNT_MISMATCH");
      await ledger.assertRetentionRestoreSafe();
      const job = await prisma.caseDeletion.findUniqueOrThrow({ where: { caseId: fixture.caseId } });
      ensure(job.holdState === "UNKNOWN" && !job.approvedAt && job.status === "FROZEN", "RESTORE_REUSED_OLD_AUTHORITY");
      let deletionBlocked = false;
      try { await retention.inventoryCaseDeletion(job.id, fixture.actorId); }
      catch (error) { deletionBlocked = error instanceof Error && error.message === "DELETION_NOT_APPROVED"; }
      ensure(deletionBlocked, "RESTORE_ALLOWED_ERASURE_WITHOUT_NEW_REVIEW");
      const { caseReadAccess } = await import("../src/domain/caseAccess");
      const quarantined = await prisma.case.findUniqueOrThrow({ where: { id: fixture.caseId } });
      ensure(caseReadAccess(quarantined, { userId: fixture.partyId, globalRole: "COMPLAINANT", isApprover: false }) === null, "RESTORED_PARTY_ACCESS_WAS_NOT_BLOCKED");
      console.log(JSON.stringify({ phase: name, restoredDatabase: true, restoredObjectDigestVerified: true, startupInitiallyBlocked: true, replayQuarantined: true, partyAccessBlocked: true, renewedReviewRequired: true, ledgerDigest }));
      return;
    }
    throw new Error("UNKNOWN_DRILL_PHASE");
  } finally { await prisma.$disconnect(); }
}

async function main() {
  if (process.argv[2] === "--phase") return phase(process.argv[3]);
  ensure(process.env.RETENTION_DRILL_ALLOWED === "true", "EXPLICIT_ISOLATED_DRILL_OPT_IN_REQUIRED");
  const owner = connection("RETENTION_TEST_OWNER_DATABASE_URL");
  const runtime = connection("DATABASE_URL");
  const purger = connection("RETENTION_PURGER_DATABASE_URL");
  ensure(owner.host === runtime.host && owner.host === purger.host, "DRILL_CONNECTIONS_MUST_USE_SAME_TEST_SERVER");
  ensure(new Set([owner.username, runtime.username, purger.username]).size === 3, "DRILL_REQUIRES_THREE_SEPARATE_ROLES");
  const suffix = randomUUID().replaceAll("-", "");
  const source = `aequitas_drill_source_${suffix}_test`;
  const restored = `aequitas_drill_restore_${suffix}_test`;
  const directory = await mkdtemp(join(tmpdir(), "aequitas-retention-restore-"));
  const sourceObjects = join(directory, "source-objects");
  const snapshotObjects = join(directory, "object-snapshot");
  const restoredObjects = join(directory, "restored-objects");
  const ledgerPath = join(directory, "independent-ledger.json");
  const admin = new Client({ connectionString: dbUrl(owner, "postgres"), connectionTimeoutMillis: 5000 });
  const created: string[] = [];
  let cleanupFailed = false;
  let receipt: Record<string, unknown> | undefined;
  try {
    await admin.connect();
    // Existing test logins are prerequisites. Do not create or alter global
    // login identities, credentials or memberships in this drill.
    for (const role of [decodeURIComponent(runtime.username), decodeURIComponent(purger.username)]) {
      ensure((await admin.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [role])).rowCount === 1, "DRILL_TEST_ROLES_MUST_BE_PROVISIONED");
    }
    for (const database of [source, restored]) { await admin.query(`CREATE DATABASE "${database}"`); created.push(database); }
    execFileSync(process.execPath, [join(repository, "node_modules/prisma/build/index.js"), "migrate", "deploy"], { cwd: repository, env: { ...process.env, DATABASE_URL: dbUrl(owner, source) }, stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
    const runtimeRole = decodeURIComponent(runtime.username);
    const purgerRole = decodeURIComponent(purger.username);
    ensure(/^[a-z_][a-z0-9_]*$/.test(runtimeRole) && /^[a-z_][a-z0-9_]*$/.test(purgerRole), "DRILL_REQUIRES_SIMPLE_ROLE_NAMES");
    const grants = `GRANT USAGE ON SCHEMA public TO "${runtimeRole}"; GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${runtimeRole}";\n`;
    const provision = await readFile(join(repository, "deploy/retention/provision-purger.sql"), "utf8");
    const provisionArgs = ["-v", "ON_ERROR_STOP=1", "-v", `runtime_role=${runtimeRole}`, "-v", `purger_role=${purgerRole}`];
    pgTool(owner, source, "psql", provisionArgs, grants + provision);
    await mkdir(sourceObjects);
    const common = { ...process.env, RETENTION_ENFORCEMENT_ENABLED: "true", RETENTION_LEDGER_PATH: ledgerPath, RETENTION_DRILL_MANIFEST: join(directory, "fixture.json") };
    const sourceEnv = { ...common, DATABASE_URL: dbUrl(runtime, source), RETENTION_PURGER_DATABASE_URL: dbUrl(purger, source), STORAGE_LOCAL_DIR: sourceObjects };
    const seeded = runPhase("seed", sourceEnv);
    // The database dump and object snapshot deliberately exclude the newer
    // independent ledger. Both capture genuine pre-deletion data.
    const dump = pgTool(owner, source, "pg_dump", ["--format=custom", "--no-owner", "--no-privileges"]);
    const dumpDigest = sha256(dump);
    await cp(sourceObjects, snapshotObjects, { recursive: true });
    const erased = runPhase("erase", sourceEnv);
    await cp(snapshotObjects, sourceObjects, { recursive: true });
    const objectOnlyReplay = runPhase("restore-object-only", sourceEnv);
    pgTool(owner, restored, "pg_restore", ["--no-owner", "--no-privileges", "--exit-on-error", "--dbname", restored], dump);
    pgTool(owner, restored, "psql", provisionArgs, grants + provision);
    await cp(snapshotObjects, restoredObjects, { recursive: true });
    const replayed = runPhase("restore-replay", { ...common, DATABASE_URL: dbUrl(runtime, restored), RETENTION_PURGER_DATABASE_URL: dbUrl(purger, restored), STORAGE_LOCAL_DIR: restoredObjects });
    receipt = { drill: "actual-database-and-object-snapshot-restore", pgDump: pgTool(owner, source, "pg_dump", ["--version"]).toString("utf8").trim(), dumpSha256: dumpDigest, seeded, erased, objectOnlyReplay, replayed, productionTouched: false };
  } finally {
    for (const database of created.reverse()) {
      try { await admin.query(`DROP DATABASE "${database}"`); }
      catch { cleanupFailed = true; }
    }
    for (const database of created) {
      try { if ((await admin.query("SELECT 1 FROM pg_database WHERE datname=$1", [database])).rowCount !== 0) cleanupFailed = true; }
      catch { cleanupFailed = true; }
    }
    await admin.end();
    try { await rm(directory, { recursive: true, force: true }); } catch { cleanupFailed = true; }
    if (cleanupFailed) throw new Error("OWNED_DRILL_RESOURCE_CLEANUP_FAILED");
  }
  ensure(receipt, "DRILL_RECEIPT_MISSING");
  console.log(JSON.stringify({ ...receipt, ownedDatabasesRemoved: true, ownedFilesRemoved: true }));
}

main().catch(error => {
  // Safe error labels only: child stderr/connection strings can contain secrets.
  const message = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : "RETENTION_RESTORE_DRILL_FAILED";
  console.error(JSON.stringify({ ok: false, error: message }));
  process.exitCode = 1;
});
