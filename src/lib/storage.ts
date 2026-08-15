import { createHash } from "node:crypto";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const client = new S3Client({
  endpoint: process.env.STORAGE_ENDPOINT,
  region: process.env.STORAGE_REGION,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.STORAGE_ACCESS_KEY ?? "",
    secretAccessKey: process.env.STORAGE_SECRET_KEY ?? "",
  },
});

const SIMULATED_PREFIX = process.env.STORAGE_SIMULATED_PREFIX ?? "simulated/";
const LIVE_PREFIX = "live/";

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

  const bucket = process.env.STORAGE_BUCKET;
  if (!bucket) throw new Error("STORAGE_BUCKET is not configured.");

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: storageKey,
      Body: input.buffer,
      ContentType: input.mimeType,
    })
  );

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
  const bucket = process.env.STORAGE_BUCKET;
  if (!bucket) throw new Error("STORAGE_BUCKET is not configured.");

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: input.storageKey,
      Body: input.buffer,
      ContentType: input.mimeType,
    })
  );

  return { sha256, byteSize: input.buffer.byteLength };
}

/** Server-side fetch-and-stream-through — no presigned-URL infra exists yet, so downloads proxy through this app rather than pointing the browser at MinIO directly. */
export async function downloadBuffer(storageKey: string): Promise<Buffer> {
  const bucket = process.env.STORAGE_BUCKET;
  if (!bucket) throw new Error("STORAGE_BUCKET is not configured.");
  const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: storageKey }));
  const bytes = await res.Body!.transformToByteArray();
  return Buffer.from(bytes);
}
