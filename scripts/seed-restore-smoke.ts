/** Synthetic fixture for CI's real isolated restore. Never uses the main test DB. */
import "../src/lib/loadEnv";
import { createHash } from "node:crypto";
import { lstat, readdir, realpath, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { appendEvent } from "../src/domain/events";

async function main() {
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (url.pathname !== "/aequitas_restore_test" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("Restore smoke requires a dedicated loopback aequitas_restore_test database.");
  }
  const supplied = process.env.STORAGE_LOCAL_DIR;
  if (!supplied) throw new Error("An explicit empty STORAGE_LOCAL_DIR is required.");
  const directory = resolve(supplied);
  if (!(await lstat(directory)).isDirectory() || await realpath(directory) !== directory || (await readdir(directory)).length !== 0) {
    throw new Error("Restore smoke storage must be an existing empty directory without symlinks.");
  }

  const { prisma } = await import("../src/lib/prisma");
  try {
    if (await prisma.user.count() || await prisma.case.count() || await prisma.event.count() || await prisma.evidenceItem.count()) {
      throw new Error("Restore smoke refuses a database containing application rows.");
    }
    const bytes = Buffer.from("Aequitas isolated restore smoke: synthetic evidence only.\n");
    const storageKey = "restore-smoke.txt";
    await writeFile(resolve(directory, storageKey), bytes, { flag: "wx", mode: 0o644 });
    await prisma.$transaction(async tx => {
      const complainant = await tx.user.create({ data: {
        id: "10000000-0000-4000-8000-000000000001", email: "restore-complainant@example.invalid", displayName: "Synthetic restore complainant", globalRole: "COMPLAINANT",
      } });
      const respondent = await tx.user.create({ data: {
        id: "10000000-0000-4000-8000-000000000002", email: "restore-respondent@example.invalid", displayName: "Synthetic restore respondent", globalRole: "RESPONDENT",
      } });
      const caseRow = await tx.case.create({ data: {
        id: "10000000-0000-4000-8000-000000000003", referenceNumber: "AE-RESTORE-SMOKE", state: "EVIDENCE_INTAKE", simulated: true,
        disputeDescription: "Synthetic restore verification fixture.", complainantId: complainant.id, respondentId: respondent.id,
      } });
      await appendEvent(tx, { caseId: caseRow.id, actorId: complainant.id, type: "CASE_CREATED", payload: {} });
      await appendEvent(tx, { caseId: caseRow.id, actorId: complainant.id, type: "CASE_SUBMITTED", payload: {} });
      await appendEvent(tx, { caseId: caseRow.id, actorId: complainant.id, type: "EVIDENCE_INTAKE_OPENED", payload: {} });
      const evidence = await tx.evidenceItem.create({ data: {
        id: "10000000-0000-4000-8000-000000000004", caseId: caseRow.id, submittedById: complainant.id,
        kind: "OTHER", title: "Synthetic restore evidence", storageKey, mimeType: "text/plain", scanStatus: "CLEAN", simulated: true,
        sha256: createHash("sha256").update(bytes).digest("hex"), byteSize: bytes.length,
      } });
      await appendEvent(tx, { caseId: caseRow.id, actorId: complainant.id, type: "EVIDENCE_SUBMITTED", payload: { evidenceId: evidence.id } });
    });
    console.log("Restore smoke fixture: 2 synthetic users, 1 case, 4 events, 1 matching evidence file.");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Restore smoke fixture failed.");
  process.exitCode = 1;
});
