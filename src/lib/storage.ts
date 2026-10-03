import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

/**
 * Two storage backends, chosen at call time, not at import time:
 * - Railway (or any plain long-running Node server): the local filesystem,
 *   under STORAGE_LOCAL_DIR — a Railway volume mounted at that path makes
 *   this durable across deploys/restarts, and it's the one backend that
 *   needs no external object-storage account at all. Checked first since
 *   it's this app's actual deployment target.
 * - Local dev / tests: the S3 SDK against MinIO (STORAGE_ENDPOINT etc.).
 */
function getLocalDir(): string | null {
  return process.env.STORAGE_LOCAL_DIR || null;
}

function validateStorageKey(storageKey: string) {
  if (!storageKey || storageKey.startsWith("/") || storageKey.includes("\\") || storageKey.split("/").some(segment => segment === "." || segment === "..")) throw new Error("Invalid storage key");
}

let s3Client: S3Client | null = null;
function getS3Client(): S3Client {
  if (!s3Client) {
    s3Client = new S3Client({
      endpoint: process.env.STORAGE_ENDPOINT,
      region: process.env.STORAGE_REGION,
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.STORAGE_ACCESS_KEY ?? "",
        secretAccessKey: process.env.STORAGE_SECRET_KEY ?? "",
      },
    });
  }
  return s3Client;
}

const SIMULATED_PREFIX = process.env.STORAGE_SIMULATED_PREFIX ?? "simulated/";
const LIVE_PREFIX = "live/";

async function putObject(storageKey: string, buffer: Buffer, mimeType: string): Promise<void> {
  validateStorageKey(storageKey);
  const localDir = getLocalDir();
  if (localDir) {
    // turbopackIgnore: STORAGE_LOCAL_DIR is a runtime-only config value (a
    // Railway volume mount path), never a build-time constant — there's
    // nothing here for Turbopack's static file-tracer to usefully resolve,
    // and without the ignore it traces (and bundles) the whole project.
    const path = join(/*turbopackIgnore: true*/ localDir, storageKey);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, buffer);
    return;
  }

  const bucket = process.env.STORAGE_BUCKET;
  if (!bucket) throw new Error("STORAGE_BUCKET is not configured.");
  await getS3Client().send(new PutObjectCommand({ Bucket: bucket, Key: storageKey, Body: buffer, ContentType: mimeType }));
}

async function getObject(storageKey: string): Promise<Buffer> {
  validateStorageKey(storageKey);
  const localDir = getLocalDir();
  if (localDir) {
    return readFile(join(/*turbopackIgnore: true*/ localDir, storageKey));
  }

  const bucket = process.env.STORAGE_BUCKET;
  if (!bucket) throw new Error("STORAGE_BUCKET is not configured.");
  const res = await getS3Client().send(new GetObjectCommand({ Bucket: bucket, Key: storageKey }));
  if (!res.Body) throw new Error(`S3 object not found: ${storageKey}`);
  const bytes = await res.Body.transformToByteArray();
  return Buffer.from(bytes);
}

export interface UploadEvidenceInput {
  caseId: string;
  evidenceId: string;
  simulated: boolean;
  buffer: Buffer;
  mimeType: string;
}

export interface UploadEvidenceResult {
  storageKey: string;
  sha256: string;
  byteSize: number;
}

/**
 * Section 11: "stored under live/{caseId}/{evidenceId} or
 * simulated/{caseId}/{evidenceId} — the prefix is chosen from the case flag
 * and cannot be influenced by the request body." `simulated` here comes
 * from the caller reading Case.simulated server-side, never from the
 * upload request itself.
 */
export async function uploadEvidence(input: UploadEvidenceInput): Promise<UploadEvidenceResult> {
  const prefix = input.simulated ? SIMULATED_PREFIX : LIVE_PREFIX;
  const storageKey = `${prefix}${input.caseId}/${input.evidenceId}`;
  const sha256 = createHash("sha256").update(input.buffer).digest("hex");

  try { await putObject(storageKey, input.buffer, input.mimeType); }
  catch (error) { await rollbackBuffer(storageKey); throw error; }

  return { storageKey, sha256, byteSize: input.buffer.byteLength };
}

export interface UploadBufferInput {
  storageKey: string;
  buffer: Buffer;
  mimeType: string;
}

/**
 * Generic upload for callers that already know their own storage key
 * (Section 15's export bundle: `exports/{live|simulated}/{caseId}/{exportId}.zip`,
 * same live/simulated prefix rule as evidence — see exportBundle.ts) rather
 * than the case/evidence-id-derived key uploadEvidence() builds.
 */
export async function uploadBuffer(input: UploadBufferInput): Promise<{ sha256: string; byteSize: number }> {
  const sha256 = createHash("sha256").update(input.buffer).digest("hex");
  try { await putObject(input.storageKey, input.buffer, input.mimeType); }
  catch (error) { await rollbackBuffer(input.storageKey); throw error; }
  return { sha256, byteSize: input.buffer.byteLength };
}

/** Server-side fetch-and-stream-through — no presigned-URL infra exists yet, so downloads proxy through this app rather than pointing the browser at storage directly. */
export async function downloadBuffer(storageKey: string): Promise<Buffer> {
  return getObject(storageKey);
}

export async function deleteBuffer(storageKey: string): Promise<void> {
  validateStorageKey(storageKey);
  const localDir = getLocalDir();
  if (localDir) {
    await rm(join(/*turbopackIgnore: true*/ localDir, storageKey), { force: true });
    return;
  }
  const bucket = process.env.STORAGE_BUCKET;
  if (!bucket) throw new Error("STORAGE_BUCKET is not configured.");
  await getS3Client().send(new DeleteObjectCommand({ Bucket: bucket, Key: storageKey }));
}

/** Cleanup must not hide the original domain/storage failure if storage is unavailable. */
export async function rollbackBuffer(storageKey: string): Promise<void> {
  try { await deleteBuffer(storageKey); }
  catch { console.error("Uncommitted storage object cleanup failed; reconciliation required.", { storageKey }); }
}
