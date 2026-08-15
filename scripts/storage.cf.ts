import { createHash } from "node:crypto";

/**
 * Cloudflare-build-only variant of src/lib/storage.ts — R2 native binding
 * only, no @aws-sdk/client-s3 import. Swapped in by scripts/cf-build.sh
 * (and restored afterward) purely to shrink the Worker bundle; the AWS SDK
 * is dead weight on this deployment target since R2 fully replaces it.
 * Keep this in sync with storage.ts's public API/behavior by hand — it's a
 * deliberate, small duplication, not a shared abstraction, because the two
 * files can never both be compiled into the same build.
 */
async function getR2Bucket(): Promise<R2Bucket> {
  const { getCloudflareContext } = await import("@opennextjs/cloudflare");
  const { env } = getCloudflareContext();
  if (!env.EVIDENCE_BUCKET) throw new Error("EVIDENCE_BUCKET binding is not configured.");
  return env.EVIDENCE_BUCKET;
}

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

export async function uploadEvidence(input: UploadEvidenceInput): Promise<UploadEvidenceResult> {
  const prefix = input.simulated ? SIMULATED_PREFIX : LIVE_PREFIX;
  const storageKey = `${prefix}${input.caseId}/${input.evidenceId}`;
  const sha256 = createHash("sha256").update(input.buffer).digest("hex");
  const r2 = await getR2Bucket();
  await r2.put(storageKey, input.buffer, { httpMetadata: { contentType: input.mimeType } });
  return { storageKey, sha256, byteSize: input.buffer.byteLength };
}

export interface UploadBufferInput {
  storageKey: string;
  buffer: Buffer;
  mimeType: string;
}

export async function uploadBuffer(input: UploadBufferInput): Promise<{ sha256: string; byteSize: number }> {
  const sha256 = createHash("sha256").update(input.buffer).digest("hex");
  const r2 = await getR2Bucket();
  await r2.put(input.storageKey, input.buffer, { httpMetadata: { contentType: input.mimeType } });
  return { sha256, byteSize: input.buffer.byteLength };
}

export async function downloadBuffer(storageKey: string): Promise<Buffer> {
  const r2 = await getR2Bucket();
  const object = await r2.get(storageKey);
  if (!object) throw new Error(`R2 object not found: ${storageKey}`);
  return Buffer.from(await object.arrayBuffer());
}
