import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { prisma } from "../../src/lib/prisma";
const gate = vi.hoisted(() => ({ uploaded: () => {}, continue: Promise.resolve() }));
vi.mock("../../src/lib/scan", () => ({ scanBuffer: async () => ({ clean: true }) }));
vi.mock("../../src/lib/storage", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/lib/storage")>();
  return { ...actual, uploadEvidence: async (input: Parameters<typeof actual.uploadEvidence>[0]) => {
    const result = await actual.uploadEvidence(input);
    gate.uploaded();
    await gate.continue;
    return result;
  } };
});
import { submitEvidence } from "../../src/domain/mutate";
let storage: string;
beforeAll(async () => { storage = await mkdtemp(join(tmpdir(), "aequitas-upload-fence-")); vi.stubEnv("STORAGE_LOCAL_DIR", storage); });
afterAll(async () => { vi.unstubAllEnvs(); await rm(storage, { recursive: true, force: true }); });

it("inventories a real upload until publication settles, even when freeze wins the DB write", async () => {
  const id = randomUUID();
  const complainant = await prisma.user.create({ data: { email: `upload-c-${id}@example.org`, displayName: "Upload fixture", globalRole: "COMPLAINANT" } });
  const respondent = await prisma.user.create({ data: { email: `upload-r-${id}@example.org`, displayName: "Upload fixture", globalRole: "RESPONDENT" } });
  const row = await prisma.case.create({ data: { referenceNumber: `AE-UPLOAD-FENCE-${id}`, complainantId: complainant.id, respondentId: respondent.id, state: "EVIDENCE_INTAKE", simulated: true } });
  let uploaded!: () => void;
  const didUpload = new Promise<void>(resolve => { uploaded = resolve; });
  let resume!: () => void;
  gate.uploaded = uploaded;
  gate.continue = new Promise<void>(resolve => { resume = resolve; });
  const submission = submitEvidence({ caseId: row.id, actorId: complainant.id, actorRole: "COMPLAINANT", kind: "DOCUMENT", title: "Synthetic fixture", buffer: Buffer.from("Synthetic evidence"), mimeType: "text/plain" });
  await didUpload;
  const active = await prisma.caseOperation.findFirstOrThrow({ where: { caseId: row.id } });
  expect(active.status).toBe("ACTIVE");
  expect(active.storageKeys).toHaveLength(1);
  expect(await stat(join(storage, active.storageKeys[0]))).toBeTruthy();
  await prisma.case.update({ where: { id: row.id }, data: { deletionStartedAt: new Date() } });
  resume();
  expect((await submission).ok).toBe(false);
  const finished = await prisma.caseOperation.findUniqueOrThrow({ where: { id: active.id } });
  expect(finished.status).toBe("UNCERTAIN");
  expect(finished.storageKeys).toEqual(active.storageKeys);
  expect(await prisma.evidenceItem.count({ where: { caseId: row.id } })).toBe(0);
  await expect(stat(join(storage, active.storageKeys[0]))).rejects.toMatchObject({ code: "ENOENT" });
});
